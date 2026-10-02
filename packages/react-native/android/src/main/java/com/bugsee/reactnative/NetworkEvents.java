package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.exchange.NetworkEvent;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Builds a network event the app recorded itself and hands it to the SDK.
 *
 * <p>The timestamp is stamped here. The event comes from the exchange factory
 * the caller supplies (production: {@code Bugsee.getExchangeFactory()}), then
 * goes back with filtering required so an installed network filter still sees
 * it. A missing factory or a null event is {@link Outcome#NO_EVENT}; the
 * caller logs {@code addNetworkEvent dropped: the SDK made no event} and does
 * not invent a timeout that would pass the event through.
 *
 * <p>This class does not call {@code Bugsee.getLaunchOptions()}, so a plain
 * JVM test can drive it.
 */
final class NetworkEvents {

    enum Outcome {
        ADDED,
        NO_EVENT,
        REJECTED
    }

    /** The SDK exchange factory's {@code createNetworkEvent}. */
    interface Factory {
        @Nullable
        NetworkEvent create(
                long timestamp,
                @NonNull NetworkEvent.NetworkEventStage stage,
                @Nullable String eventId,
                @Nullable String mechanism,
                @Nullable String method
        );
    }

    /** {@code Bugsee.addNetworkEvent(event, requiresFiltering)}. */
    interface Recorder {
        void add(@NonNull NetworkEvent event, boolean requiresFiltering);
    }

    interface Clock {
        long now();
    }

    /** What the bundle's network events say this wrapper recorded them as. */
    static final String MECHANISM = "react-native";

    private NetworkEvents() {
    }

    @NonNull
    static Outcome record(
            @Nullable final String eventJson,
            @Nullable final Factory factory,
            @NonNull final Recorder recorder,
            @NonNull final Clock clock
    ) {
        final JSONObject object;
        try {
            object = new JSONObject(eventJson);
        } catch (final JSONException e) {
            return Outcome.REJECTED;
        }
        final String url = stringOrNull(object, "url");
        final String method = stringOrNull(object, "method");
        if (url == null || method == null) {
            return Outcome.REJECTED;
        }
        final NetworkEvent.NetworkEventStage stage = stageOf(stringOrAbsent(object, "stage"));
        if (stage == null) {
            return Outcome.REJECTED;
        }
        if (!fieldsAreWritable(object)) {
            return Outcome.REJECTED;
        }
        if (factory == null) {
            return Outcome.NO_EVENT;
        }
        final NetworkEvent event;
        try {
            event = factory.create(clock.now(), stage, stringOrAbsent(object, "id"), MECHANISM, method);
        } catch (final Throwable e) {
            return Outcome.NO_EVENT;
        }
        if (event == null) {
            return Outcome.NO_EVENT;
        }
        try {
            apply(event, object, url);
        } catch (final Throwable e) {
            return Outcome.REJECTED;
        }
        // Filtering is required. An installed setNetworkFilter must see this
        // event. Never pass false.
        recorder.add(event, true);
        return Outcome.ADDED;
    }

    /**
     * {@code completed} is the name JS and the device test use. The SDK's
     * own {@code toString} for that stage is {@code complete}.
     */
    @Nullable
    static NetworkEvent.NetworkEventStage stageOf(@Nullable final String name) {
        if (name == null || "completed".equals(name) || "complete".equals(name)) {
            return NetworkEvent.NetworkEventStage.RequestCompleted;
        }
        final String wire;
        if ("started".equals(name)) {
            wire = "before";
        } else if ("aborted".equals(name) || "cancel".equals(name)) {
            wire = "abort";
        } else if ("timings".equals(name)) {
            wire = "timing";
        } else {
            wire = name;
        }
        return NetworkEvent.NetworkEventStage.fromString(wire, null);
    }

    private static boolean fieldsAreWritable(@NonNull final JSONObject object) {
        if (object.has("body") && !isStringOrNull(object, "body")) {
            return false;
        }
        if (object.has("statusText") && !isStringOrNull(object, "statusText")) {
            return false;
        }
        if (object.has("errorDescription") && !isStringOrNull(object, "errorDescription")) {
            return false;
        }
        if (object.has("errorShortMessage") && !isStringOrNull(object, "errorShortMessage")) {
            return false;
        }
        if (object.has("id") && !isStringOrNull(object, "id")) {
            return false;
        }
        if (object.has("responseCode") && !(object.opt("responseCode") instanceof Number)) {
            return false;
        }
        if (!object.has("headers") || object.isNull("headers")) {
            return true;
        }
        final Object headers = object.opt("headers");
        if (!(headers instanceof JSONObject)) {
            return false;
        }
        final JSONObject map = (JSONObject) headers;
        final Iterator<String> keys = map.keys();
        while (keys.hasNext()) {
            final String key = keys.next();
            if (!(map.opt(key) instanceof String)) {
                return false;
            }
        }
        return true;
    }

    private static void apply(
            @NonNull final NetworkEvent event,
            @NonNull final JSONObject object,
            @NonNull final String url
    ) throws JSONException {
        event.setUrl(url);
        if (object.has("body")) {
            event.setBody(stringOrNull(object, "body"));
        }
        if (object.has("statusText")) {
            event.setStatusText(stringOrNull(object, "statusText"));
        }
        if (object.has("errorDescription")) {
            event.setErrorDescription(stringOrNull(object, "errorDescription"));
        }
        if (object.has("errorShortMessage")) {
            event.setErrorShortMessage(stringOrNull(object, "errorShortMessage"));
        }
        if (object.has("responseCode")) {
            event.setResponseCode(object.getInt("responseCode"));
        }
        if (object.has("headers") && !object.isNull("headers")) {
            final JSONObject headers = object.getJSONObject("headers");
            final Map<String, String> map = new HashMap<>();
            final Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                final String key = keys.next();
                map.put(key, headers.getString(key));
            }
            event.setHeaders(map);
        } else if (object.has("headers")) {
            event.setHeaders(null);
        }
    }

    private static boolean isStringOrNull(@NonNull final JSONObject object, @NonNull final String key) {
        return object.isNull(key) || object.opt(key) instanceof String;
    }

    @Nullable
    private static String stringOrNull(@NonNull final JSONObject object, @NonNull final String key) {
        if (!object.has(key) || object.isNull(key)) {
            return null;
        }
        final Object value = object.opt(key);
        return value instanceof String ? (String) value : null;
    }

    /** A present string, or null when the key was left out. A JSON null is null. */
    @Nullable
    private static String stringOrAbsent(@NonNull final JSONObject object, @NonNull final String key) {
        if (!object.has(key) || object.isNull(key)) {
            return null;
        }
        final Object value = object.opt(key);
        return value instanceof String ? (String) value : null;
    }
}
