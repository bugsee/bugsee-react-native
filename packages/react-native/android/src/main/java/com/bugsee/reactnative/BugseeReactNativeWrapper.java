package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.common.DataRequestResultCallback;
import com.bugsee.library.contracts.internal.BugseeWrapper;
import com.bugsee.library.contracts.reporting.Report;

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

    /**
     * The backend's identifier for this wrapper. Duplicated from
     * {@code WRAPPER_TYPE} in {@code src/wrapper/identity.ts} because the
     * provider registers before any JS exists to supply it; a test compares
     * the two so they cannot drift into two different wrappers.
     */
    static final String WRAPPER_TYPE = "react_native";

    /**
     * The identity the SDK gets before React Native has a JS runtime.
     *
     * <p>Type and version only. Everything else in the full identity — the
     * React Native version, the engine, the build configuration — is a JS-side
     * fact, and inferring it natively would produce a second, disagreeing
     * answer. {@code setWrapperInfo} replaces this with the complete identity
     * as soon as the bridge is up.
     */
    @NonNull
    static BugseeReactNativeWrapper withoutJsRuntime() {
        return new BugseeReactNativeWrapper(
                WRAPPER_TYPE,
                BuildConfig.WRAPPER_VERSION,
                null,
                Collections.<String, String>emptyMap()
        );
    }

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
    public void onLifecycleEvent(@NonNull final String eventType, @Nullable final Object data) {
    }

    /**
     * The packed buffer the SDK expects: {@code [version, count, l,t,r,b, ...]}.
     * Nothing is redacted yet -- Task 3.3 wires real rectangles -- so this
     * publishes an empty set, which is what a count of 0 means. The version is
     * held constant BECAUSE the set never changes; changing it per call would
     * make the SDK re-read an identical set on every frame.
     */
    @Override
    public int[] getSecureRectangles(final int display) {
        return new int[] { 1, 0 };
    }

    @Override
    public void onBeforeReportCreated(
            @NonNull final Report report,
            final boolean isTerminating,
            @NonNull final Runnable completionCallback
    ) {
        // Always run it: the pipeline waits on this, so failing to call it
        // stalls the report rather than merely skipping our contribution.
        completionCallback.run();
    }

    @Override
    public void onAfterReportCreated(
            @NonNull final Report report,
            final boolean isTerminating,
            @NonNull final Runnable completionCallback
    ) {
        completionCallback.run();
    }

    @Override
    public void requestData(
            @NonNull final String dataType,
            @NonNull final DataRequestResultCallback callback
    ) {
        callback.onResult(null);
    }
}
