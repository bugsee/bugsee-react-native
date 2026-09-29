package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import android.util.Log;

import com.bugsee.library.contracts.internal.DataRequestTypes;

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
 * DataRequestTypes#VIEW_HIERARCHY_TIMEOUT_MS}), so a reply that arrives late
 * from JS still lands inside the SDK's window -- and is dropped safely by the
 * SDK itself if it does not.
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

    private static final class Entry {
        final String id;
        final Reply reply;
        /** The sink this request was emitted to; its detach completes it. */
        final Sink owner;
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
            new DataRequestBridge(new DaemonScheduler(), System::currentTimeMillis);

    @NonNull
    static DataRequestBridge shared() {
        return SHARED;
    }

    private final Scheduler scheduler;
    private final Clock clock;
    private final AtomicReference<Sink> sink = new AtomicReference<>();
    @Nullable
    private volatile OriginSource origin;
    private final Map<String, Entry> entries = new ConcurrentHashMap<>();
    private final AtomicLong counter = new AtomicLong();
    private volatile boolean viewTreeEnabled;

    DataRequestBridge(@NonNull final Scheduler scheduler, @NonNull final Clock clock) {
        this.scheduler = scheduler;
        this.clock = clock;
    }

    void setViewTreeEnabled(final boolean enabled) {
        viewTreeEnabled = enabled;
    }

    /**
     * Attaches the module of a new JS runtime, which has not enabled the view
     * tree yet -- that only happens once its own anchor mounts. Until then, a
     * request must not be emitted to a runtime that never asked for one.
     */
    void attach(@NonNull final Sink newSink, @NonNull final OriginSource newOrigin) {
        sink.set(newSink);
        origin = newOrigin;
        viewTreeEnabled = false;
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
     * Requests data of {@code type}, never throwing. See the class doc for
     * the ordering: an unknown type, no live sink (or a disabled view tree),
     * and no known origin all reply {@code null} synchronously; only then is
     * a request actually minted and emitted.
     */
    void request(@NonNull final String type, @NonNull final Reply reply) {
        try {
            if (!VIEW_HIERARCHY.equals(type)) {
                resolveUnminted(reply, "unknown-type");
                return;
            }
            final Sink target = sink.get();
            if (target == null || !viewTreeEnabled) {
                resolveUnminted(reply, "no-js");
                return;
            }
            final OriginSource originSource = origin;
            final int[] currentOrigin = originSource == null ? null : originSource.currentOrigin();
            if (currentOrigin == null) {
                resolveUnminted(reply, "no-origin");
                return;
            }

            final Entry entry = new Entry("dr-" + counter.incrementAndGet(), reply, target, clock.nowMs());
            entries.put(entry.id, entry);
            final Cancellable timer = scheduler.schedule(() -> finish(entry, null, "deadline"), DEADLINE_MS);
            entry.timer = timer;
            if (entry.done.get()) {
                // Finished between put and here; don't leave the timer armed.
                cancelQuietly(timer);
            }
            try {
                target.onDataRequest(entry.id, type, currentOrigin[0], currentOrigin[1]);
            } catch (final Throwable e) {
                // A dead bridge throws from the emit, on the SDK's thread. JS
                // will never answer, so answer for it now.
                Log.w(TAG, "data request " + entry.id + " could not reach JS", e);
                finish(entry, null, "sink-threw");
            }
        } catch (final Throwable e) {
            // Never throws: this runs on the SDK's own thread mid-capture,
            // where an exception would either crash the host or stall the
            // pass until the SDK's own timeout.
            Log.w(TAG, "data request failed unexpectedly", e);
            runQuietly(reply, null);
        }
    }

    /** @return true only for the call that delivered the payload. */
    boolean complete(@NonNull final String requestId, @Nullable final String payload) {
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
        Log.i(TAG, "data request " + entry.id + " completed by=" + by
                + " elapsed=" + (clock.nowMs() - entry.startMs) + "ms");
        return true;
    }

    /** No request was minted; the line still names the outcome for correlation. */
    private static void resolveUnminted(@NonNull final Reply reply, @NonNull final String by) {
        runQuietly(reply, null);
        Log.i(TAG, "data request - completed by=" + by);
    }

    /** Whatever JS's reply implementation does, it must not escape onto the SDK's thread. */
    private static void runQuietly(@NonNull final Reply reply, @Nullable final String payload) {
        try {
            reply.onResult(payload);
        } catch (final Throwable e) {
            Log.w(TAG, "data request reply threw", e);
        }
    }

    private static void cancelQuietly(@NonNull final Cancellable timer) {
        try {
            timer.cancel();
        } catch (final Throwable e) {
            Log.w(TAG, "data request timer cancel threw", e);
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
