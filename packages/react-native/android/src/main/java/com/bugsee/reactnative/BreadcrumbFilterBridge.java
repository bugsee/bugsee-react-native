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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The app's breadcrumb filter, as a round trip into JS.
 *
 * <p>Registered with {@link Bugsee#setBreadcrumbFilter}. {@link #filter}
 * returns without waiting. The crumb the SDK lends is a pooled entry
 * ({@code BugseeCaptureDataProviderBreadcrumb} borrows from a pool of 40),
 * but unlike {@code BugseeCaptureDataProviderLog} that pool is not recycled
 * on a 10 second filter timeout. An unanswered filter is not recorded, and
 * the entry stays the one this bridge was given, so a late reply still
 * writes it. There is no deadline here: a timer that then passed the
 * original crumb, or that called the callback with {@code null} while the
 * SDK was still waiting, would either leak the crumb or drop one the SDK
 * is prepared to record. 7.3.0's breadcrumb provider class has no
 * {@code 10000} timeout constant.
 *
 * <p>A missing sink, a snapshot that cannot be serialised, a failed emit,
 * a {@code null} reply, or a reply that does not stick passes {@code null}
 * to the SDK, which discards the crumb. This bridge never replies with the
 * original crumb after a failed filter.
 */
final class BreadcrumbFilterBridge {

    /** What the module implements to emit {@code onBreadcrumbFilterRequest}. */
    interface Sink {
        void onBreadcrumbFilterRequest(@NonNull String requestId, @NonNull String crumbJson);
    }

    private static final class Pending {
        @NonNull final String id;
        @NonNull final Breadcrumb crumb;
        @NonNull final Callback1<Breadcrumb> callback;
        @NonNull final Sink owner;

        Pending(
                @NonNull final String id,
                @NonNull final Breadcrumb crumb,
                @NonNull final Callback1<Breadcrumb> callback,
                @NonNull final Sink owner
        ) {
            this.id = id;
            this.crumb = crumb;
            this.callback = callback;
            this.owner = owner;
        }
    }

    private static final BreadcrumbFilterBridge SHARED = new BreadcrumbFilterBridge();

    @NonNull
    static BreadcrumbFilterBridge shared() {
        return SHARED;
    }

    private final AtomicReference<Sink> sink = new AtomicReference<>();
    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();
    private final AtomicLong ids = new AtomicLong();
    private final AtomicBoolean installed = new AtomicBoolean();

    /** Tests construct their own. Production uses {@link #shared()}. */
    BreadcrumbFilterBridge() {
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
            drop(item.callback);
        }
    }

    /** Installs the filter, or removes it. A second {@code true} is a no-op. */
    void setEnabled(final boolean enabled) {
        if (enabled) {
            if (installed.compareAndSet(false, true)) {
                Bugsee.setBreadcrumbFilter(filter);
            }
            return;
        }
        if (installed.compareAndSet(true, false)) {
            Bugsee.setBreadcrumbFilter(null);
        }
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
        final Pending item = new Pending(id, event, callback, current);
        pending.put(id, item);
        try {
            current.onBreadcrumbFilterRequest(id, json);
        } catch (final Throwable e) {
            if (pending.remove(id, item)) {
                drop(callback);
            }
        }
    }

    /**
     * The crumb as JSON, with only the keys the SDK actually set.
     * {@code level} is {@link Breadcrumb.Level#getValue()}, never the ordinal.
     * A zero timestamp is the pool's unset value and is omitted.
     */
    @NonNull
    static String snapshotJson(@NonNull final Breadcrumb crumb) throws JSONException {
        final JSONObject object = new JSONObject();
        final String category = crumb.getCategory();
        if (category != null) {
            object.put("category", category);
        }
        final Breadcrumb.Level level = crumb.getLevel();
        if (level != null) {
            object.put("level", level.getValue() & 0xff);
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

    /** {@link Breadcrumb.Level#fromValue(byte)} is the inverse of {@code getValue()}. */
    private static boolean writeLevel(@NonNull final Breadcrumb crumb, @Nullable final Object value) {
        if (!(value instanceof Number)) {
            return false;
        }
        final double number = ((Number) value).doubleValue();
        if (number < 1d || number > 5d || number != Math.rint(number)) {
            return false;
        }
        final Breadcrumb.Level level = Breadcrumb.Level.fromValue((byte) number);
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
}
