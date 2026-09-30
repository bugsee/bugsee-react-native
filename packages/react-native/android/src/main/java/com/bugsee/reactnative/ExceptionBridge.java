package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import android.util.Log;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Turns a JS exception payload (and optional options JSON) into the SDK's
 * {@code logException} / {@code logUnhandledException} calls. Plain Java so
 * the rules here are unit-tested without React Native or a device.
 *
 * <p>Both send paths never throw: a bad options blob is logged (message only,
 * never the text) and the exception is still sent without options; a throwing
 * SDK is swallowed the same way every other void bridge method defends the
 * host.
 */
final class ExceptionBridge {

    private static final String TAG = "BugseeRN";

    /** What the module implements against; the production adapter calls {@code Bugsee.*}. */
    interface Sdk {
        void logException(Throwable t, @Nullable Map<String, Object> options);

        void logUnhandledException(Throwable t, @Nullable Map<String, Object> options);
    }

    private ExceptionBridge() {
    }

    /**
     * {@code domain} → {@link String}, {@code labels} → {@link List}{@code String},
     * {@code includeVideo} → {@link Boolean}; other keys dropped. {@code null}
     * for null text.
     *
     * @throws BridgeJson.BadJson when the text is unparseable, or a known key
     *     has the wrong runtime type.
     */
    @Nullable
    static Map<String, Object> options(@Nullable final String optionsJson) throws BridgeJson.BadJson {
        if (optionsJson == null) {
            return null;
        }
        final Map<String, Object> raw = BridgeJson.parseObject(optionsJson);
        final Map<String, Object> result = new HashMap<>();
        if (raw.containsKey("domain")) {
            final Object domain = raw.get("domain");
            if (!(domain instanceof String)) {
                throw new BridgeJson.BadJson("domain must be a string");
            }
            result.put("domain", domain);
        }
        if (raw.containsKey("labels")) {
            result.put("labels", stringList(raw.get("labels")));
        }
        if (raw.containsKey("includeVideo")) {
            final Object includeVideo = raw.get("includeVideo");
            if (!(includeVideo instanceof Boolean)) {
                throw new BridgeJson.BadJson("includeVideo must be a boolean");
            }
            result.put("includeVideo", includeVideo);
        }
        return result;
    }

    /**
     * Never throws. Bad options are logged (code only) and the exception is
     * still sent, without options.
     */
    static void logHandled(
            @NonNull final Sdk sdk,
            @NonNull final String payloadJson,
            @Nullable final String optionsJson
    ) {
        Map<String, Object> opts = null;
        try {
            opts = options(optionsJson);
        } catch (final BridgeJson.BadJson e) {
            Log.e(TAG, "exception options rejected: " + e.getMessage());
        }
        try {
            sdk.logException(new ReactNativeWebException(payloadJson), opts);
        } catch (final RuntimeException e) {
            Log.e(TAG, "logException failed", e);
        }
    }

    /** Never throws. */
    static void logUnhandled(@NonNull final Sdk sdk, @NonNull final String payloadJson) {
        try {
            sdk.logUnhandledException(new ReactNativeWebException(payloadJson), null);
        } catch (final RuntimeException e) {
            Log.e(TAG, "logUnhandledException failed", e);
        }
    }

    @NonNull
    private static List<String> stringList(@Nullable final Object value) throws BridgeJson.BadJson {
        if (!(value instanceof List)) {
            throw new BridgeJson.BadJson("labels must be an array of strings");
        }
        final List<?> raw = (List<?>) value;
        final List<String> result = new ArrayList<>(raw.size());
        for (final Object element : raw) {
            if (!(element instanceof String)) {
                throw new BridgeJson.BadJson("labels must be an array of strings");
            }
            result.add((String) element);
        }
        return result;
    }
}
