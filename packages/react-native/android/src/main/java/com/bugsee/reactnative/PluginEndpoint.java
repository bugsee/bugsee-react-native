package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.io.Serializable;
import java.util.HashMap;
import java.util.Map;

/**
 * The Expo config plugin's {@code endpoint} option at runtime.
 *
 * <p>The plugin writes it as application meta-data under {@link #META_DATA_KEY},
 * a name only it uses. {@code launch()} and {@code relaunch()} then use it as
 * the SDK's endpoint whenever JS passed none, so the reports go where the
 * build's uploads went. An endpoint JS passed always wins. Without the
 * meta-data nothing changes: the SDK keeps its own default.
 */
public final class PluginEndpoint {

    /** Written by plugin/src/manifest.ts (RN_ENDPOINT_META_DATA). */
    public static final String META_DATA_KEY = "com.bugsee.reactnative.endpoint";

    /** The Android SDK's endpoint option (src/options/endpoint.ts). */
    static final String OPTION_KEY = "com.bugsee.option.$$ENDPOINT";

    private PluginEndpoint() {}

    /**
     * {@code options} with the configured endpoint added when it has none of
     * its own, or {@code options} itself. A blank configured value is no
     * value. The input is never modified.
     */
    @NonNull
    public static Map<String, Serializable> withDefault(
            @NonNull final Map<String, Serializable> options, @Nullable final String configured) {
        if (configured == null || options.containsKey(OPTION_KEY)) {
            return options;
        }
        final String value = configured.trim();
        if (value.isEmpty()) {
            return options;
        }
        final Map<String, Serializable> result = new HashMap<>(options);
        result.put(OPTION_KEY, value);
        return result;
    }
}
