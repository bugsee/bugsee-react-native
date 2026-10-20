package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import android.util.Log;

import java.util.Map;

/**
 * Turns a JS exception payload (and optional options JSON) into the SDK's
 * {@code logException} / {@code logUnhandledException} calls. Plain Java so
 * the rules here are unit-tested without React Native or a device.
 *
 * <p>Both send paths never throw: a bad options blob is logged (message only,
 * never the text) and the exception is still sent without a domain; a throwing
 * SDK is swallowed the same way every other void bridge method defends the
 * host.
 */
final class ExceptionBridge {

    private static final String TAG = "BugseeRN";

    /** What the module implements against; the production adapter calls {@code Bugsee.*}. */
    interface Sdk {
        void logException(Throwable t, @Nullable String domain);

        void logUnhandledException(Throwable t, @Nullable Map<String, Object> options);
    }

    private ExceptionBridge() {
    }

    /**
     * The exception domain of the options text; other keys are dropped (labels
     * and {@code includeVideo} are no longer options). {@code null} for null
     * text or no domain.
     *
     * @throws BridgeJson.BadJson when the text is unparseable, or the domain
     *     is not a string.
     */
    @Nullable
    static String domain(@Nullable final String optionsJson) throws BridgeJson.BadJson {
        if (optionsJson == null) {
            return null;
        }
        final Map<String, Object> raw = BridgeJson.parseObject(optionsJson);
        if (!raw.containsKey("domain")) {
            return null;
        }
        final Object domain = raw.get("domain");
        if (!(domain instanceof String)) {
            throw new BridgeJson.BadJson("domain must be a string");
        }
        return (String) domain;
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
        String domain = null;
        try {
            domain = domain(optionsJson);
        } catch (final BridgeJson.BadJson e) {
            Log.e(TAG, "exception options rejected: " + e.getMessage());
        }
        try {
            sdk.logException(new ReactNativeWebException(payloadJson), domain);
        } catch (final RuntimeException e) {
            Log.e(TAG, "logException failed: " + e.getClass().getName());
        }
    }

    /** Never throws. */
    static void logUnhandled(@NonNull final Sdk sdk, @NonNull final String payloadJson) {
        try {
            sdk.logUnhandledException(new ReactNativeWebException(payloadJson), null);
        } catch (final RuntimeException e) {
            Log.e(TAG, "logUnhandledException failed: " + e.getClass().getName());
        }
    }
}
