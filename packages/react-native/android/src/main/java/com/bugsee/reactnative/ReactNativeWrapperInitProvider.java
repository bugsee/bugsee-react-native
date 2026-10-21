package com.bugsee.reactnative;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.BugseeExtensionInitProviderBase;

/**
 * Registers the React Native wrapper with the SDK before the SDK can launch.
 *
 * <p>The wrapper used to be registered from JavaScript, immediately before
 * {@code launch()}. That is early enough when the app launches Bugsee itself
 * from JS, and far too late otherwise: under auto-init the SDK launches from
 * its own {@code BugseeInitProvider}, a {@link android.content.ContentProvider}
 * that runs before {@code Application.onCreate} — before any app code exists,
 * let alone a JS runtime. Anything the SDK does during that launch, including
 * dispatching report handlers for a crash recovered from the previous run,
 * happens with no wrapper registered and is silently skipped.
 *
 * <p>A provider at {@code initOrder="200"} is the only hook that runs earlier,
 * and it is the convention the SDK's own extension modules already use.
 *
 * <p>What is registered here is deliberately the identity half of the contract
 * and nothing else. Type and version are compile-time constants, so they are
 * knowable with no runtime at all. The rest — the React Native version, the JS
 * engine, whether this is a dev build — is knowable only in JS, and
 * {@code setWrapperInfo} replaces this registration with the full one once the
 * bridge is up. An early report is therefore attributed to
 * {@code react_native} with a correct wrapper version and an empty context,
 * which is strictly better than the alternative of no attribution at all.
 *
 * <p>The same early hook can close the privacy window of an auto-launched
 * SDK, opt-in: see {@link StartupHold}.
 */
public final class ReactNativeWrapperInitProvider extends BugseeExtensionInitProviderBase {

    private static final String TAG = "BugseeRN";

    @Override
    protected boolean onExtensionCreate() {
        // Through the registrar, like every registration: setWrapperInfo
        // re-registers from another thread once JS is up.
        registerEarly(WrapperRegistrar::register);
        // Opt-in: close the window before JS installs the app's filters.
        holdFiltersEarly(holdFiltersMetaData(getContext()), StartupHold.BRIDGES);
        // Conventional for an init provider: we expose no content.
        return false;
    }

    /**
     * The {@value StartupHold#META_DATA} meta-data, or null when it is absent
     * or cannot be read. Never throws: see {@link #registerEarly}.
     */
    @Nullable
    static Object holdFiltersMetaData(@Nullable final Context context) {
        try {
            if (context == null) {
                return null;
            }
            final ApplicationInfo info = context.getPackageManager()
                    .getApplicationInfo(context.getPackageName(), PackageManager.GET_META_DATA);
            return holdFiltersValueOf(info);
        } catch (Throwable t) {
            Log.e(TAG, "could not read " + StartupHold.META_DATA + ": " + t.getClass().getName());
            return null;
        }
    }

    /** The meta-data value in {@code info}, or null. */
    @Nullable
    static Object holdFiltersValueOf(@NonNull final ApplicationInfo info) {
        final Bundle data = info.metaData;
        return data == null ? null : data.get(StartupHold.META_DATA);
    }

    /** Never throws; see {@link StartupHold#apply}. */
    static void holdFiltersEarly(@Nullable final Object metaData, @NonNull final StartupHold.Targets targets) {
        try {
            final java.util.Set<String> held = StartupHold.apply(metaData, targets);
            if (targets == StartupHold.BRIDGES) {
                StartupHold.watchFromProvider(held);
            }
        } catch (Throwable t) {
            Log.e(TAG, "could not hold the filters at process start: " + t.getClass().getName());
        }
    }

    /**
     * Never throws, errors included. This runs before
     * {@code Application.onCreate} in every host app that links the library,
     * so a throw here kills the process before the app runs a line of its
     * own. Losing the early registration only costs attribution until
     * {@code setWrapperInfo} registers from JS.
     */
    static void registerEarly(@NonNull final WrapperRegistrar.Setter register) {
        try {
            register.set(BugseeReactNativeWrapper.withoutJsRuntime());
        } catch (Throwable t) {
            Log.e(TAG, "could not register the React Native wrapper at process start: "
                    + t.getClass().getName());
        }
    }
}
