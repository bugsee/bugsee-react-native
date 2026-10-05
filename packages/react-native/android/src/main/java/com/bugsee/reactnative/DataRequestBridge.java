package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import android.util.Log;

import com.bugsee.library.contracts.internal.DataRequestTypes;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Answers the SDK's {@link DataRequestTypes#VIEW_HIERARCHY} data request from
 * JS, through a table of opaque handles -- the same shape as {@link
 * ReportHandlerBridge}, which this mirrors.
 *
 * <p>Every {@link #request} ends in exactly one reply to the SDK's callback,
 * whichever of JS, the deadline, or a detach gets there first, guarded by one
 * {@link AtomicBoolean} per outstanding request. The deadline ({@link
 * #DEADLINE_MS}) is kept comfortably under the SDK's own budget ({@link
 * DataRequestTypes#VIEW_HIERARCHY_TIMEOUT_MS}): a JS reply that lands after
 * this bridge's own deadline has already fired finds its entry gone and is
 * dropped (by {@link #complete} returning {@code false}), but the bridge's
 * own {@code null} reply reaches the SDK comfortably before the SDK's own
 * timeout would otherwise fire -- every outcome is logged either way (the
 * plan's Phase 6 "Log lines").
 *
 * <p>Like {@link ReportHandlerBridge}, this outlives any one React instance:
 * the wrapper that calls in is registered at process start, while the module
 * that receives {@code onDataRequest} comes and goes with the JS runtime.
 */
final class DataRequestBridge {

    private static final String TAG = "BugseeRN";

    /** Mirrors the SDK's own constant, rather than duplicating its value. */
    static final String VIEW_HIERARCHY = DataRequestTypes.VIEW_HIERARCHY;

    /**
     * Comfortably under {@link DataRequestTypes#VIEW_HIERARCHY_TIMEOUT_MS}
     * (500 ms): JS must get a chance to reply before the SDK's own timeout
     * fires and starts ignoring it.
     */
    static final long DEADLINE_MS = 450;

    /** What the module implements to emit {@code onDataRequest}. */
    interface Sink {
        void onDataRequest(String requestId, String type, int originX, int originY);
    }

    /** The React root's current display origin. Called on the requesting (main) thread. */
    interface OriginSource {
        @Nullable
        int[] currentOrigin();
    }

    /** What {@link #request} calls back with the answer. */
    interface Reply {
        void onResult(@Nullable String data);
    }

    interface Cancellable {
        void cancel();
    }

    /** Arms a request's deadline. Injectable so tests control time. */
    interface Scheduler {
        Cancellable schedule(Runnable task, long delayMs);
    }

    /** Its own interface: {@code java.util.function} needs API 24, minSdk is 21. */
    interface Clock {
        long nowMs();
    }

    /**
     * Where the one-line outcome of every request goes. Logcat in production,
     * where the device tests match these lines (the plan's Phase 6 "Log
     * lines"); injectable so the JVM tests can pin the exact formats too.
     */
    interface OutcomeLog {
        void line(String message);
    }

    private static final class Entry {
        final String id;
        final Reply reply;
        /** The sink this request was emitted to; its detach completes it. */
        final Sink owner;
        /** Taken on entry to {@link #request}, before any check. */
        final long startMs;
        /** The exactly-once guard. Whoever flips it runs the reply. */
        final AtomicBoolean done = new AtomicBoolean();
        volatile Cancellable timer;

        Entry(final String id, final Reply reply, final Sink owner, final long startMs) {
            this.id = id;
            this.reply = reply;
            this.owner = owner;
            this.startMs = startMs;
        }
    }

    private static final DataRequestBridge SHARED =
            new DataRequestBridge(new DaemonScheduler(), () -> System.nanoTime() / 1_000_000L);

    @NonNull
    static DataRequestBridge shared() {
        return SHARED;
    }

    private final Scheduler scheduler;
    private final Clock clock;
    private final OutcomeLog outcomes;
    private final AtomicReference<Sink> sink = new AtomicReference<>();
    @Nullable
    private volatile OriginSource origin;
    private final Map<String, Entry> entries = new ConcurrentHashMap<>();
    private final AtomicLong counter = new AtomicLong();
    private volatile boolean viewTreeEnabled;

    DataRequestBridge(@NonNull final Scheduler scheduler, @NonNull final Clock clock) {
        this(scheduler, clock, message -> Log.i(TAG, message));
    }

    DataRequestBridge(
            @NonNull final Scheduler scheduler,
            @NonNull final Clock clock,
            @NonNull final OutcomeLog outcomes
    ) {
        this.scheduler = scheduler;
        this.clock = clock;
        this.outcomes = outcomes;
    }

    /**
     * The attached runtime's anchor mounted ({@code true}) or unmounted
     * ({@code false}). A caller that is not the attached sink is ignored.
     * The flag is process-wide, and a reload can still run the old module's
     * last {@code setViewTreeEnabled(false)} after the new module has
     * attached and enabled — the same window {@link #detach} already
     * identity-checks. Applying that write would leave the live runtime at
     * {@code by=no-js} until its anchor count passed through zero again.
     */
    void setViewTreeEnabled(@NonNull final Sink caller, final boolean enabled) {
        if (sink.get() == caller) {
            viewTreeEnabled = enabled;
        }
    }

    /**
     * Attaches the module of a new JS runtime, which has not enabled the view
     * tree yet -- that only happens once its own anchor mounts. The flag and
     * the origin are cleared BEFORE the sink is published: a {@link #request}
     * that reads the new sink must never see the previous runtime's leftover
     * state.
     */
    void attach(@NonNull final Sink newSink, @NonNull final OriginSource newOrigin) {
        viewTreeEnabled = false;
        origin = newOrigin;
        sink.set(newSink);
    }

    /**
     * Completes every request emitted to {@code stale} with {@code null}:
     * nothing in any other JS runtime knows them, so waiting for their
     * deadlines would only delay the SDK's capture. Clears the sink, the
     * origin and the enabled flag only if {@code stale} is still the attached
     * one -- a fast reload attaches the new module before the old one is
     * invalidated, and an unconditional clear would silence it.
     */
    void detach(@NonNull final Sink stale) {
        if (sink.compareAndSet(stale, null)) {
            origin = null;
            viewTreeEnabled = false;
        }
        for (final Entry entry : entries.values()) {
            if (entry.owner == stale) {
                finish(entry, null, "detach");
            }
        }
    }

    /**
     * The number of requests currently outstanding (minted, not yet
     * completed). Package-private, for tests: every terminal path must leave
     * this at zero.
     */
    int outstanding() {
        return entries.size();
    }

    /**
     * Requests data of {@code type}, never throwing. See the class doc for
     * the ordering: an unknown type, no live sink (or a disabled view tree),
     * and no known origin all reply {@code null} synchronously; only then is
     * a request actually minted and emitted.
     */
    void request(@NonNull final String type, @NonNull final Reply reply) {
        // Taken as the first statement: the plan's "ms" is measured from the
        // moment requestData was entered, not from whenever a request happens
        // to be minted.
        final long start = clock.nowMs();
        final String id = "dr-" + counter.incrementAndGet();
        Entry entry = null;
        try {
            if (!VIEW_HIERARCHY.equals(type)) {
                resolveUnminted(id, start, reply, "unknown-type");
                return;
            }
            final Sink target = sink.get();
            if (target == null || !viewTreeEnabled) {
                resolveUnminted(id, start, reply, "no-js");
                return;
            }
            final OriginSource originSource = origin;
            final int[] currentOrigin = originSource == null ? null : originSource.currentOrigin();
            if (currentOrigin == null) {
                resolveUnminted(id, start, reply, "no-origin");
                return;
            }

            entry = new Entry(id, reply, target, start);
            entries.put(entry.id, entry);
            final Entry armed = entry;
            final Cancellable timer = scheduler.schedule(() -> finish(armed, null, "deadline"), DEADLINE_MS);
            armed.timer = timer;
            if (armed.done.get()) {
                // Finished between put and here; don't leave the timer armed.
                cancelQuietly(timer);
            }
            // The real race: a detach() ran after the sink was read above but
            // before the entry was in the table, so its sweep could not see
            // this one. Whichever side comes second must still catch it --
            // otherwise it emits to a dead runtime and waits out the whole
            // deadline for nothing.
            if (sink.get() != target) {
                finish(armed, null, "detach");
                return;
            }
            outcomes.line("data request " + id + " type=" + type
                    + " origin=" + currentOrigin[0] + "," + currentOrigin[1]);
            try {
                target.onDataRequest(id, type, currentOrigin[0], currentOrigin[1]);
            } catch (final Throwable e) {
                // A dead bridge throws from the emit, on the SDK's thread. JS
                // will never answer, so answer for it now.
                Log.w(TAG, "data request " + id + " could not reach JS: " + e.getClass().getName());
                finish(armed, null, "sink-threw");
            }
        } catch (final Throwable e) {
            // Never throws: this runs on the SDK's own thread mid-capture,
            // where an exception would either crash the host or stall the
            // pass until the SDK's own timeout. If a request was already
            // minted (entries.put succeeded but something after it threw --
            // e.g. the scheduler rejecting the task), it must still be
            // completed through finish(): replying directly here and leaving
            // the entry behind would both leak it and let a later detach()
            // reply to the SDK a second time.
            Log.w(TAG, "data request failed unexpectedly: " + e.getClass().getName());
            if (entry != null) {
                finish(entry, null, "failed");
            } else {
                resolveUnminted(id, start, reply, "failed");
            }
        }
    }

    /**
     * @return true only for the call that delivered the payload. {@code
     * null} is treated as an unknown id rather than throwing: {@code
     * replyDataRequest} is a void TurboModule method, and JS always echoes
     * the id it was given, so this only guards against misuse.
     */
    boolean complete(@Nullable final String requestId, @Nullable final String payload) {
        if (requestId == null) {
            return false;
        }
        final Entry entry = entries.get(requestId);
        return entry != null && finish(entry, payload, "js");
    }

    private boolean finish(@NonNull final Entry entry, @Nullable final String payload, @NonNull final String by) {
        if (!entry.done.compareAndSet(false, true)) {
            return false;
        }
        entries.remove(entry.id, entry);
        final Cancellable timer = entry.timer;
        if (timer != null) {
            cancelQuietly(timer);
        }
        runQuietly(entry.reply, payload);
        logCompleted(entry.id, by, payload, entry.startMs);
        return true;
    }

    /** No request was minted; the line still names the outcome for correlation. */
    private void resolveUnminted(
            @NonNull final String id,
            final long startMs,
            @NonNull final Reply reply,
            @NonNull final String by
    ) {
        runQuietly(reply, null);
        logCompleted(id, by, null, startMs);
    }

    /**
     * {@code data request <id> completed by=<…> bytes=<n|null> ms=<elapsed>},
     * verbatim from the plan's Phase 6 "Log lines". {@code bytes} is the
     * UTF-8 byte count of the payload, not its UTF-16 character length --
     * iOS's {@code BGSRNDataRequestBridge} (Task 6.6) must use the same
     * definition so the two platforms' bundles read the same way.
     */
    private void logCompleted(
            @NonNull final String id,
            @NonNull final String by,
            @Nullable final String payload,
            final long startMs
    ) {
        outcomes.line("data request " + id + " completed by=" + by
                + " bytes=" + bytesOf(payload) + " ms=" + (clock.nowMs() - startMs));
    }

    @NonNull
    private static String bytesOf(@Nullable final String payload) {
        return payload == null ? "null" : String.valueOf(payload.getBytes(StandardCharsets.UTF_8).length);
    }

    /** Whatever JS's reply implementation does, it must not escape onto the SDK's thread. */
    private static void runQuietly(@NonNull final Reply reply, @Nullable final String payload) {
        try {
            reply.onResult(payload);
        } catch (final Throwable e) {
            Log.w(TAG, "data request reply threw: " + e.getClass().getName());
        }
    }

    private static void cancelQuietly(@NonNull final Cancellable timer) {
        try {
            timer.cancel();
        } catch (final Throwable e) {
            Log.w(TAG, "data request timer cancel threw: " + e.getClass().getName());
        }
    }

    /** One daemon thread, started on first use, for every request's deadline. */
    private static final class DaemonScheduler implements Scheduler {
        private final ScheduledThreadPoolExecutor executor;

        DaemonScheduler() {
            executor = new ScheduledThreadPoolExecutor(1, runnable -> {
                final Thread thread = new Thread(runnable, "BugseeRN-DataRequestDeadline");
                thread.setDaemon(true);
                return thread;
            });
            // A request completed by JS should not leave a dead task queued.
            executor.setRemoveOnCancelPolicy(true);
        }

        @Override
        public Cancellable schedule(final Runnable task, final long delayMs) {
            final ScheduledFuture<?> future = executor.schedule(task, delayMs, TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        }
    }
}
