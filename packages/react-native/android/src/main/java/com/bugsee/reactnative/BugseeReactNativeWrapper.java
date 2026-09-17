package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.common.DataRequestResultCallback;
import com.bugsee.library.contracts.internal.BugseeWrapper;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * What the SDK asks a wrapper to say about itself.
 *
 * The values are gathered in JS and handed down, because that is where they
 * are knowable: the React Native version comes from
 * {@code Platform.constants}, the engine from whether Hermes installed its
 * global, and the build configuration from {@code __DEV__}. Nothing here
 * infers them natively, which would produce a second, disagreeing answer.
 *
 * <p>Lifecycle events, secure rectangles and report handling are the other
 * halves of this contract and arrive in later tasks; the interface supplies
 * defaults for them, so an incomplete wrapper is still valid.
 */
final class BugseeReactNativeWrapper implements BugseeWrapper {

    private final String type;
    private final String version;
    @Nullable
    private final String build;
    private final Map<String, String> context;

    BugseeReactNativeWrapper(
            @NonNull final String type,
            @NonNull final String version,
            @Nullable final String build,
            @NonNull final Map<String, String> context
    ) {
        this.type = type;
        this.version = version;
        this.build = build;
        this.context = Collections.unmodifiableMap(new HashMap<>(context));
    }

    @Override
    public String getWrapperType() {
        return type;
    }

    @Override
    public String getWrapperVersion() {
        return version;
    }

    @Override
    @Nullable
    public String getWrapperBuild() {
        return build;
    }

    @Override
    public Map<String, String> getContext() {
        return context;
    }

    /**
     * The SDK asks a wrapper for data it cannot see itself — today only
     * {@code "vh"}, the JS view hierarchy, which the capture builder requests
     * while composing a frame.
     *
     * <p>Nothing is supplied yet: the React Native view hierarchy arrives with
     * the capture work in a later phase. The contract says an unsupported type
     * answers with null, and answering is the important half — a provider that
     * never calls back leaves the SDK waiting mid-capture.
     */
    @Override
    public void requestData(
            @NonNull final String dataType,
            @NonNull final DataRequestResultCallback callback
    ) {
        callback.onResult(null);
    }
}
