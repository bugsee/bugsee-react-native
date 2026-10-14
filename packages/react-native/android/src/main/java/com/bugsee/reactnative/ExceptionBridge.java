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
 * never the text) and the exception is still sent without options; a throwing
 * SDK is swallowed the same way every other void bridge method defends the
 * host.
 */
final class ExceptionBridge {

    private static final String TAG = "BugseeRN";

    /** What the module implements against; the production adapter calls {@code Bugsee.*}. */
    interface Sdk {
        void logException(Throwable t, @Nullable String domain, int skipFrames);

        void logUnhandledException(Throwable t, @Nullable Map<String, Object> options);
    }

    /** The JS options, parsed. */
    static final class Options {
        @Nullable final String domain;

        Options(@Nullable final String domain) {
            this.domain = domain;
        }
    }

    private ExceptionBridge() {
    }

    /**
     * {@code domain} → {@link String}; other keys, {@code labels} and
     * {@code includeVideo} among them, dropped. {@code null} for null text.
     *
     * @throws BridgeJson.BadJson when the text is unparseable, or a known key
     *     has the wrong runtime type.
     */
    @Nullable
    static Options options(@Nullable final String optionsJson) throws BridgeJson.BadJson {
        if (optionsJson == null) {
            return null;
        }
        final Map<String, Object> raw = BridgeJson.parseObject(optionsJson);
        String domain = null;
        if (raw.containsKey("domain")) {
            final Object value = raw.get("domain");
            if (!(value instanceof String)) {
                throw new BridgeJson.BadJson("domain must be a string");
            }
            domain = (String) value;
        }
        return new Options(domain);
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
        Options opts = null;
        try {
            opts = options(optionsJson);
        } catch (final BridgeJson.BadJson e) {
            Log.e(TAG, "exception options rejected: " + e.getMessage());
        }
        try {
            // skipFrames 0: it leaves top Java frames out of the report's signature,
            // and an RN report is keyed on the JS signature in the payload.
            sdk.logException(
                    new ReactNativeWebException(payloadJson),
                    opts == null ? null : opts.domain,
                    0);
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
