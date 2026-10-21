package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.common.Callback1;
import com.bugsee.library.contracts.exchange.Breadcrumb;
import com.bugsee.library.contracts.exchange.EventFilter;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.LongSupplier;

/**
 * The app's breadcrumb filter, as a round trip into JS.
 *
 * <p>Registered with {@link Bugsee#setBreadcrumbFilter}. {@link #filter}
 * returns without waiting. The crumb the SDK lends is a pooled entry
 * ({@code BugseeCaptureDataProviderBreadcrumb} borrows from a pool of 40).
 * Unlike {@code BugseeCaptureDataProviderLog} and the network provider, the
 * SDK has no filter timeout and never recycles that entry: an unanswered
 * crumb is not recorded and its entry is held for the session, and so is a
 * crumb that is answered {@code null} (SDK 7.4.2 {@code doLogBreadcrumb}
 * returns without recycling). That is SDK-side and not something this
 * bridge can undo.
 *
 * <p>What this bridge owns is its own pending request. It forgets one that
 * JS has not answered by {@link #DEADLINE_MS} and passes {@code null} to the
 * SDK, which discards the crumb, failing closed. (The log and network bridges
 * use the same 9 s, but only stop waiting then, without calling the callback:
 * their SDK providers drop at 10 s themselves.) A timer that passed the
 * original crumb would leak exactly what the filter exists to redact. A
 * reply after the deadline finds nothing pending and is a no-op.
 *
 * <p>A missing sink, a snapshot that cannot be serialised, a failed emit,
 * a {@code null} reply, or a reply that does not stick passes {@code null}
 * to the SDK, which discards the crumb. This bridge never replies with the
 * original crumb after a failed filter.
 */
final class BreadcrumbFilterBridge {

    /** What the module implements to emit {@code onBreadcrumbFilterRequest}. */
    interface Sink {
        /**
         * {@code addId} is the manual add in progress, or null for an SDK
         * crumb. It is not a key of {@code crumbJson}.
         */
        void onBreadcrumbFilterRequest(
                @NonNull String requestId,
                @NonNull String crumbJson,
                @Nullable String addId
        );
    }

    /** Cancels a pending request's deadline. */
    interface Cancellable {
        void cancel();
    }

    /** Arms a request's deadline. Injectable so tests control time. */
    interface Scheduler {
        @NonNull
        Cancellable schedule(@NonNull Runnable task, long delayMs);
    }

    /**
     * How long JS gets to answer one crumb before it is dropped. The SDK has
     * no deadline of its own for this filter; this is the same number the
     * log and network bridges forget at.
     */
    static final long DEADLINE_MS = 9_000L;

    private static final class Pending {
        @NonNull final String id;
        @NonNull final Breadcrumb crumb;
        @NonNull final Callback1<Breadcrumb> callback;
        @NonNull final Sink owner;
        /** {@code System.nanoTime()}-style instant after which a reply is refused. */
        final long expiresAtNanos;
        @Nullable volatile Cancellable deadline;

        Pending(
                @NonNull final String id,
                @NonNull final Breadcrumb crumb,
                @NonNull final Callback1<Breadcrumb> callback,
                @NonNull final Sink owner,
                final long expiresAtNanos
        ) {
            this.expiresAtNanos = expiresAtNanos;
            this.id = id;
            this.crumb = crumb;
            this.callback = callback;
            this.owner = owner;
        }
    }

    private static final BreadcrumbFilterBridge SHARED = new BreadcrumbFilterBridge(new DaemonScheduler());

    @NonNull
    static BreadcrumbFilterBridge shared() {
        return SHARED;
    }

    private final AtomicReference<Sink> sink = new AtomicReference<>();
    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();
    private final AtomicLong ids = new AtomicLong();
    private final AtomicBoolean installed = new AtomicBoolean();
    private final Object sdkLock = new Object();
    /**
     * The id of the manual {@code addBreadcrumb} on this thread. Set only
     * around {@link Bugsee#addBreadcrumb}. The filter request for that add
     * takes it; an SDK crumb on this thread does not see it afterwards.
     */
    private final ThreadLocal<String> manualAddId = new ThreadLocal<>();

    private final Scheduler scheduler;
    private final LongSupplier nanoClock;

    /** Tests pass a scheduler they fire themselves. Production uses {@link #shared()}. */
    BreadcrumbFilterBridge(@NonNull final Scheduler scheduler) {
        this(scheduler, System::nanoTime);
    }

    /** Tests also pass a clock, to pass the deadline without the timer having run. */
    BreadcrumbFilterBridge(@NonNull final Scheduler scheduler, @NonNull final LongSupplier nanoClock) {
        this.scheduler = scheduler;
        this.nanoClock = nanoClock;
    }

    private final EventFilter<Breadcrumb> filter = new EventFilter<Breadcrumb>() {
        @Override
        public void filter(
                @NonNull final Breadcrumb event,
                @NonNull final Callback1<Breadcrumb> callback
        ) {
            try {
                ask(event, callback);
            } catch (final Throwable e) {
                // The SDK rethrows a filter exception. Drop the crumb instead.
                drop(callback);
            }
        }
    };

    void attach(@NonNull final Sink next) {
        sink.set(next);
    }

    /**
     * Drops every request this sink was asked. A reload can attach the new
     * module first; the sink is cleared only when {@code current} is still
     * it, but {@code current}'s pending entries are always removed. The
     * callback is run with {@code null}, which discards the crumb.
     */
    void detach(@NonNull final Sink current) {
        sink.compareAndSet(current, null);
        final List<Pending> owned = new ArrayList<>();
        for (final Pending item : pending.values()) {
            if (item.owner == current && pending.remove(item.id, item)) {
                owned.add(item);
            }
        }
        for (final Pending item : owned) {
            cancel(item.deadline);
            drop(item.callback);
        }
    }

    /**
     * Serializes {@link #setEnabled} with {@code Bugsee.addBreadcrumb}. Both
     * TurboModule calls return a value, so both run on the JS thread, in the
     * order JS made them. The lock covers the install becoming visible to an
     * add. It does not order them: a queued {@code void} enable could still
     * run after an add made on a later line. The lock is reentrant: the
     * filter runs inside the add.
     */
    void withSdkLock(@NonNull final Runnable body) {
        synchronized (sdkLock) {
            body.run();
        }
    }

    /** Installs the filter, or removes it. A second {@code true} is a no-op. */
    void setEnabled(final boolean enabled) {
        withSdkLock(() -> {
            if (enabled) {
                if (installed.compareAndSet(false, true)) {
                    Bugsee.setBreadcrumbFilter(filter);
                }
                return;
            }
            if (installed.compareAndSet(true, false)) {
                Bugsee.setBreadcrumbFilter(null);
            }
        });
    }

    /**
     * Applies JS's answer onto the same crumb and returns that crumb.
     * {@code null} drops it. A JSON object is written onto the fields it
     * names; a field it omits stays as the SDK left it. {@code timestamp}
     * is not written. If a write does not stick, the crumb is dropped
     * rather than kept unredacted. A second reply is a no-op.
     */
    void reply(@NonNull final String requestId, @Nullable final String crumbJson) {
        final Pending item = pending.remove(requestId);
        if (item == null) {
            return;
        }
        cancel(item.deadline);
        // The timer can run late: past the deadline the answer is refused even
        // if it got here first.
        if (nanoClock.getAsLong() - item.expiresAtNanos >= 0) {
            drop(item.callback);
            return;
        }
        try {
            if (crumbJson == null || !apply(item.crumb, crumbJson)) {
                drop(item.callback);
                return;
            }
        } catch (final Throwable e) {
            drop(item.callback);
            return;
        }
        try {
            item.callback.run(item.crumb);
        } catch (final Throwable ignored) {
            // The SDK already treats a throw from the callback as a drop.
        }
    }

    /** Marks {@code addId} as the manual add on this thread, until {@link #ask} emits it. */
    void beginManualAdd(@NonNull final String addId) {
        manualAddId.set(addId);
    }

    /**
     * Takes the manual id if {@link #ask} did not emit it. Null means the
     * filter request for this add already carried the id, or none was begun.
     */
    @Nullable
    String takeUnclaimedManualAdd() {
        final String id = manualAddId.get();
        manualAddId.remove();
        return id;
    }

    void ask(
            @NonNull final Breadcrumb event,
            @NonNull final Callback1<Breadcrumb> callback
    ) {
        final Sink current = sink.get();
        if (current == null) {
            drop(callback);
            return;
        }
        final String json;
        try {
            json = snapshotJson(event);
        } catch (final Throwable e) {
            drop(callback);
            return;
        }
        final String id = Long.toString(ids.incrementAndGet());
        final Pending item = new Pending(
                id, event, callback, current,
                nanoClock.getAsLong() + TimeUnit.MILLISECONDS.toNanos(DEADLINE_MS));
        pending.put(id, item);
        final String addId = manualAddId.get();
        try {
            item.deadline = scheduler.schedule(() -> expire(id), DEADLINE_MS);
            current.onBreadcrumbFilterRequest(id, json, addId);
            if (addId != null) {
                manualAddId.remove();
            }
        } catch (final Throwable e) {
            if (pending.remove(id, item)) {
                cancel(item.deadline);
                drop(callback);
            }
        }
    }

    /**
     * JS did not answer in time. Forget the request and drop the crumb. The
     * SDK never recycles this entry, so a late reply has nothing to write
     * onto: it finds no pending request and returns.
     */
    private void expire(@NonNull final String id) {
        final Pending item = pending.remove(id);
        if (item != null) {
            drop(item.callback);
        }
    }

    private static void cancel(@Nullable final Cancellable deadline) {
        if (deadline == null) {
            return;
        }
        try {
            deadline.cancel();
        } catch (final Throwable ignored) {
            // A timer that cannot be cancelled only finds nothing pending.
        }
    }

    /**
     * The crumb as JSON, with only the keys the SDK actually set.
     * {@code level} is the JS name ({@code debug}, {@code info},
     * {@code warning}, {@code error}, {@code fatal}), never
     * {@link Breadcrumb.Level#getValue()} and never the ordinal.
     * A zero timestamp is the pool's unset value and is omitted.
     */
    @NonNull
    static String snapshotJson(@NonNull final Breadcrumb crumb) throws JSONException {
        final JSONObject object = new JSONObject();
        final String category = crumb.getCategory();
        if (category != null) {
            object.put("category", category);
        }
        final String level = levelName(crumb.getLevel());
        if (level != null) {
            object.put("level", level);
        }
        final String message = crumb.getMessage();
        if (message != null) {
            object.put("message", message);
        }
        final String type = crumb.getType();
        if (type != null) {
            object.put("type", type);
        }
        final Map<String, Object> data = crumb.getData();
        if (data != null) {
            object.put("data", jsonValue(data));
        }
        final long timestamp = crumb.getTimestamp();
        if (timestamp != 0L) {
            object.put("timestamp", timestamp);
        }
        return object.toString();
    }

    @NonNull
    private static Object jsonValue(@Nullable final Object value) throws JSONException {
        if (value == null) {
            return JSONObject.NULL;
        }
        if (value instanceof String || value instanceof Boolean
                || value instanceof Integer || value instanceof Long) {
            return value;
        }
        if (value instanceof Number) {
            return ((Number) value).doubleValue();
        }
        if (value instanceof Map) {
            final JSONObject object = new JSONObject();
            for (final Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!(entry.getKey() instanceof String)) {
                    throw new JSONException("data key is not a string");
                }
                object.put((String) entry.getKey(), jsonValue(entry.getValue()));
            }
            return object;
        }
        if (value instanceof Iterable) {
            final JSONArray array = new JSONArray();
            for (final Object item : (Iterable<?>) value) {
                array.put(jsonValue(item));
            }
            return array;
        }
        throw new JSONException("data value is not JSON");
    }

    /**
     * Writes the keys {@code json} names. Returns whether every write stuck.
     * A field the object omits is left alone. {@code timestamp} is ignored.
     */
    private static boolean apply(@NonNull final Breadcrumb crumb, @NonNull final String json)
            throws BridgeJson.BadJson {
        final HashMap<String, Object> kept = BridgeJson.parseObject(json);
        if (kept.containsKey("category") && !writeText(crumb, "category", kept.get("category"))) {
            return false;
        }
        if (kept.containsKey("message") && !writeText(crumb, "message", kept.get("message"))) {
            return false;
        }
        if (kept.containsKey("type") && !writeText(crumb, "type", kept.get("type"))) {
            return false;
        }
        if (kept.containsKey("level") && !writeLevel(crumb, kept.get("level"))) {
            return false;
        }
        if (kept.containsKey("data") && !writeData(crumb, kept.get("data"))) {
            return false;
        }
        return true;
    }

    private static boolean writeText(
            @NonNull final Breadcrumb crumb,
            @NonNull final String key,
            @Nullable final Object value
    ) {
        if (!(value instanceof String)) {
            return false;
        }
        final String text = (String) value;
        if ("category".equals(key)) {
            crumb.setCategory(text);
            return text.equals(crumb.getCategory());
        }
        if ("message".equals(key)) {
            crumb.setMessage(text);
            return text.equals(crumb.getMessage());
        }
        crumb.setType(text);
        return text.equals(crumb.getType());
    }

    /**
     * The JS name for {@code level}. {@code null} when the crumb has none.
     * The name is what crosses the bridge. {@link Breadcrumb.Level#getValue()}
     * stays on this side: debug 1, info 2, warning 3, error 4, fatal 5.
     */
    @Nullable
    static String levelName(@Nullable final Breadcrumb.Level level) {
        if (level == Breadcrumb.Level.DEBUG) {
            return "debug";
        }
        if (level == Breadcrumb.Level.INFO) {
            return "info";
        }
        if (level == Breadcrumb.Level.WARNING) {
            return "warning";
        }
        if (level == Breadcrumb.Level.ERROR) {
            return "error";
        }
        if (level == Breadcrumb.Level.FATAL) {
            return "fatal";
        }
        return null;
    }

    /**
     * {@code name} as a {@link Breadcrumb.Level}, or {@code null} when it is
     * not one of the JS names. A number is not a name.
     */
    @Nullable
    static Breadcrumb.Level levelFromName(@Nullable final String name) {
        if ("debug".equals(name)) {
            return Breadcrumb.Level.DEBUG;
        }
        if ("info".equals(name)) {
            return Breadcrumb.Level.INFO;
        }
        if ("warning".equals(name)) {
            return Breadcrumb.Level.WARNING;
        }
        if ("error".equals(name)) {
            return Breadcrumb.Level.ERROR;
        }
        if ("fatal".equals(name)) {
            return Breadcrumb.Level.FATAL;
        }
        return null;
    }

    /** A keep's {@code level} is the name. An integer does not stick. */
    private static boolean writeLevel(@NonNull final Breadcrumb crumb, @Nullable final Object value) {
        if (!(value instanceof String)) {
            return false;
        }
        final Breadcrumb.Level level = levelFromName((String) value);
        if (level == null) {
            return false;
        }
        crumb.setLevel(level);
        return level == crumb.getLevel();
    }

    private static boolean writeData(@NonNull final Breadcrumb crumb, @Nullable final Object value) {
        if (value == null) {
            crumb.setData(null);
            return crumb.getData() == null;
        }
        if (!(value instanceof Map)) {
            return false;
        }
        @SuppressWarnings("unchecked")
        final Map<String, Object> data = (Map<String, Object>) value;
        crumb.setData(data);
        final Map<String, Object> stored = crumb.getData();
        return stored != null && stored.equals(data);
    }

    private static void drop(@NonNull final Callback1<Breadcrumb> callback) {
        try {
            callback.run(null);
        } catch (final Throwable ignored) {
            // The SDK already treats a throw from the callback as a drop.
        }
    }

    /** One daemon thread, started on first use, for every request's deadline. */
    private static final class DaemonScheduler implements Scheduler {
        private final ScheduledThreadPoolExecutor executor;

        DaemonScheduler() {
            executor = new ScheduledThreadPoolExecutor(1, runnable -> {
                final Thread thread = new Thread(runnable, "BugseeRN-BreadcrumbFilterDeadline");
                thread.setDaemon(true);
                return thread;
            });
            executor.setRemoveOnCancelPolicy(true);
        }

        @Override
        @NonNull
        public Cancellable schedule(@NonNull final Runnable task, final long delayMs) {
            final ScheduledFuture<?> future = executor.schedule(task, delayMs, TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        }
    }
}
