package com.bugsee.reactnative;

import com.bugsee.library.Bugsee;
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
 */
public final class ReactNativeWrapperInitProvider extends BugseeExtensionInitProviderBase {

    @Override
    protected boolean onExtensionCreate() {
        Bugsee.setWrapper(BugseeReactNativeWrapper.withoutJsRuntime());
        // Conventional for an init provider: we expose no content.
        return false;
    }
}
