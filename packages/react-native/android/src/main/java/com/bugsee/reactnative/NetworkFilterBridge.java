package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.common.Callback1;
import com.bugsee.library.contracts.exchange.EventFilter;
import com.bugsee.library.contracts.exchange.NetworkEvent;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The app's network filter, as a round trip into JS.
 *
 * <p>Registered with {@link Bugsee#setNetworkEventFilter}. {@link #filter}
 * returns without waiting. The SDK's {@code FilterCallbackWrapper} is a pooled
 * {@link Callback1}: at {@link #BORROW_MS} it recycles the entry and a later
 * {@code run} is ignored. This bridge forgets the pending request at that
 * same moment without calling the callback, so a later reply cannot write
 * onto the recycled entry or pass the original event through. A reply after
 * {@link NetworkEvent#getUrl()} (or {@link NetworkEvent#getId()}) has changed
 * returns without writing and without {@code callback.run}.
 */
final class NetworkFilterBridge {

    /** What the module implements to emit {@code onNetworkFilterRequest}. */
    interface Sink {
        void onNetworkFilterRequest(@NonNull String requestId, @NonNull String eventJson);
    }

    /** Arms the moment a pending request is forgotten. Injectable so tests control time. */
    interface Cancellable {
        void cancel();
    }

    /** Arms a request's deadline. Injectable so tests control time. */
    interface Scheduler {
        @NonNull
        Cancellable schedule(@NonNull Runnable task, long delayMs);
    }

    /**
     * {@code BugseeCaptureDataProviderNetwork.FILTER_CALLBACK_TIMEOUT_MS}.
     * The SDK recycles the entry at this age. Forgetting the pending here
     * discards JS's answer; it does not pass the event through.
     */
    static final long BORROW_MS = 10_000L;

    private static final class Pending {
        @NonNull final String id;
        @NonNull final NetworkEvent event;
        @Nullable final String originalId;
        @Nullable final String originalUrl;
        @NonNull final Callback1<NetworkEvent> callback;
        @NonNull final Sink owner;
        @Nullable Cancellable deadline;

        Pending(
                @NonNull final String id,
                @NonNull final NetworkEvent event,
                @Nullable final String originalId,
                @Nullable final String originalUrl,
                @NonNull final Callback1<NetworkEvent> callback,
                @NonNull final Sink owner
        ) {
            this.id = id;
            this.event = event;
            this.originalId = originalId;
            this.originalUrl = originalUrl;
            this.callback = callback;
            this.owner = owner;
        }
    }

    private static final NetworkFilterBridge SHARED = new NetworkFilterBridge();

    @NonNull
    static NetworkFilterBridge shared() {
        return SHARED;
    }

    private final Scheduler scheduler;
    private final AtomicReference<Sink> sink = new AtomicReference<>();
    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();
    private final AtomicLong ids = new AtomicLong();
    private final AtomicBoolean installed = new AtomicBoolean();

    /** Production: one daemon thread forgets pending requests at {@link #BORROW_MS}. */
    private NetworkFilterBridge() {
        this(new DaemonScheduler());
    }

    /** Tests pass a scheduler they fire themselves. */
    NetworkFilterBridge(@NonNull final Scheduler scheduler) {
        this.scheduler = scheduler;
    }

    private final EventFilter<NetworkEvent> filter = new EventFilter<NetworkEvent>() {
        @Override
        public void filter(
                @NonNull final NetworkEvent event,
                @NonNull final Callback1<NetworkEvent> callback
        ) {
            try {
                ask(event, callback);
            } catch (final Throwable e) {
                drop(callback);
            }
        }
    };

    void attach(@NonNull final Sink next) {
        sink.set(next);
    }

    /**
     * Drops every request this sink was asked, while the entry is still the
     * SDK's live borrow. After the entry has been recycled, the pending is
     * forgotten and the callback is not touched.
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
            if (stillBorrowed(item)) {
                drop(item.callback);
            }
        }
    }

    /** Installs the filter, or removes it. A second {@code true} is a no-op. */
    void setEnabled(final boolean enabled) {
        if (enabled) {
            if (installed.compareAndSet(false, true)) {
                Bugsee.setNetworkEventFilter(filter);
            }
            return;
        }
        if (installed.compareAndSet(true, false)) {
            Bugsee.setNetworkEventFilter(null);
        }
    }

    /**
     * Applies JS's answer. {@code null} drops the event, while the entry is
     * still the one the SDK lent us. A JSON object may replace {@code url},
     * {@code body} and {@code headers}; the same event is returned, so the
     * timestamp and the stage stay. A field the entry ignores is a drop
     * rather than an unredacted keep.
     *
     * <p>If {@code getId()} or {@code getUrl()} is no longer the original,
     * the pooled entry has been recycled. This returns without writing and
     * without {@code callback.run}.
     */
    void reply(@NonNull final String requestId, @Nullable final String eventJson) {
        final Pending item = pending.remove(requestId);
        if (item == null) {
            return;
        }
        cancel(item.deadline);
        if (!stillBorrowed(item)) {
            return;
        }
        if (eventJson == null) {
            drop(item.callback);
            return;
        }
        try {
            if (!apply(item.event, eventJson)) {
                drop(item.callback);
                return;
            }
        } catch (final Throwable e) {
            drop(item.callback);
            return;
        }
        item.callback.run(item.event);
    }

    void ask(
            @NonNull final NetworkEvent event,
            @NonNull final Callback1<NetworkEvent> callback
    ) {
        final String url;
        final String id;
        try {
            url = event.getUrl();
            id = event.getId();
        } catch (final Throwable e) {
            drop(callback);
            return;
        }
        final Sink current = sink.get();
        // A null URL cannot tell a recycled entry (reset nulls the URL) from
        // the one we were asked about, so it is dropped rather than lent.
        if (url == null || current == null) {
            drop(callback);
            return;
        }
        final String eventJson;
        try {
            eventJson = snapshot(event);
        } catch (final Throwable e) {
            drop(callback);
            return;
        }
        final String requestId = Long.toString(ids.incrementAndGet());
        final Pending item = new Pending(requestId, event, id, url, callback, current);
        pending.put(requestId, item);
        try {
            item.deadline = scheduler.schedule(() -> forget(requestId), BORROW_MS);
            current.onNetworkFilterRequest(requestId, eventJson);
        } catch (final Throwable e) {
            if (pending.remove(requestId, item)) {
                cancel(item.deadline);
                drop(callback);
            }
        }
    }

    /**
     * The SDK has recycled the entry, or is about to. Forget the request and
     * do not call the callback: calling it would pass the original event
     * through, or touch an entry that now belongs to another event.
     */
    private void forget(@NonNull final String id) {
        pending.remove(id);
    }

    /** The entry is still the SDK's borrow of the event we were asked to filter. */
    private static boolean stillBorrowed(@NonNull final Pending item) {
        try {
            return Objects.equals(item.originalId, item.event.getId())
                    && Objects.equals(item.originalUrl, item.event.getUrl());
        } catch (final Throwable ignored) {
            return false;
        }
    }

    /**
     * Writes the replacement onto {@code event}. Returns false when the
     * JSON is not an event object, a field is an illegal type, or a write
     * does not stick.
     */
    private static boolean apply(@NonNull final NetworkEvent event, @NonNull final String eventJson)
            throws JSONException {
        final JSONObject object = new JSONObject(eventJson);
        if (object.has("url") && !applyUrl(event, object)) {
            return false;
        }
        if (object.has("body") && !applyBody(event, object)) {
            return false;
        }
        return !object.has("headers") || applyHeaders(event, object);
    }

    private static boolean applyUrl(@NonNull final NetworkEvent event, @NonNull final JSONObject object)
            throws JSONException {
        if (object.isNull("url")) {
            event.setUrl(null);
            return event.getUrl() == null;
        }
        final Object raw = object.get("url");
        if (!(raw instanceof String)) {
            return false;
        }
        final String url = (String) raw;
        event.setUrl(url);
        return url.equals(event.getUrl());
    }

    private static boolean applyBody(@NonNull final NetworkEvent event, @NonNull final JSONObject object)
            throws JSONException {
        if (object.isNull("body")) {
            event.setBody(null);
            return event.getBody() == null;
        }
        final Object raw = object.get("body");
        if (!(raw instanceof String)) {
            return false;
        }
        final String body = (String) raw;
        event.setBody(body);
        return body.equals(event.getBody());
    }

    private static boolean applyHeaders(@NonNull final NetworkEvent event, @NonNull final JSONObject object)
            throws JSONException {
        if (object.isNull("headers")) {
            event.setHeaders(null);
            return event.getHeaders() == null;
        }
        final Object raw = object.get("headers");
        if (!(raw instanceof JSONObject)) {
            return false;
        }
        final JSONObject headers = (JSONObject) raw;
        final Map<String, String> map = new HashMap<>();
        final Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            final String key = keys.next();
            final Object value = headers.get(key);
            if (!(value instanceof String)) {
                return false;
            }
            map.put(key, (String) value);
        }
        event.setHeaders(map);
        return map.equals(event.getHeaders());
    }

    @NonNull
    private static String snapshot(@NonNull final NetworkEvent event) throws JSONException {
        final JSONObject object = new JSONObject();
        put(object, "id", event.getId());
        put(object, "url", event.getUrl());
        put(object, "method", event.getMethod());
        put(object, "body", event.getBody());
        put(object, "mechanism", event.getMechanism());
        final NetworkEvent.NetworkEventStage stage = event.getNetworkEventType();
        put(object, "type", stage == null ? null : stage.toString());
        final NetworkEvent.WebSocketEventType websocket = event.getWebSocketEventType();
        final String websocketEvent = stage == NetworkEvent.NetworkEventStage.WebSocket && websocket != null
                ? websocket.getValue()
                : null;
        put(object, "websocketEvent", websocketEvent);
        object.put("responseCode", event.getResponseCode());
        final Map<String, String> headers = event.getHeaders();
        if (headers == null) {
            object.put("headers", JSONObject.NULL);
        } else {
            final JSONObject headerJson = new JSONObject();
            for (final Map.Entry<String, String> entry : headers.entrySet()) {
                if (entry.getKey() != null && entry.getValue() != null) {
                    headerJson.put(entry.getKey(), entry.getValue());
                }
            }
            object.put("headers", headerJson);
        }
        return object.toString();
    }

    private static void put(
            @NonNull final JSONObject object,
            @NonNull final String key,
            @Nullable final String value
    ) throws JSONException {
        object.put(key, value == null ? JSONObject.NULL : value);
    }

    private static void cancel(@Nullable final Cancellable deadline) {
        if (deadline == null) {
            return;
        }
        try {
            deadline.cancel();
        } catch (final Throwable ignored) {
            // A timer that cannot be cancelled still only forgets the pending.
        }
    }

    private static void drop(@NonNull final Callback1<NetworkEvent> callback) {
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
                final Thread thread = new Thread(runnable, "BugseeRN-NetworkFilterDeadline");
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
