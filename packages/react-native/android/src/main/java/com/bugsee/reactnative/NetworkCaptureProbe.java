package com.bugsee.reactnative;

import android.util.Log;

import androidx.annotation.NonNull;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.Interceptor;
import okhttp3.OkHttpClient;

/**
 * Tells whether JS {@code fetch}/XHR traffic can reach Bugsee on this build.
 *
 * <p>React Native's networking runs on OkHttp. The SDK sees that traffic only
 * through the interceptor the Bugsee Gradle plugin injects into every
 * {@code OkHttpClient.Builder.build()}. An app that skips the plugin builds
 * and launches fine and records no network events, with nothing to say so.
 * {@link #warnOnceIfNotInstrumented()} makes that visible: it builds a client
 * the way RN does and looks for the interceptor on it.
 *
 * <p>The client has to come from React Native's own code
 * ({@code OkHttpClientProvider.createClient()}, passed in by the module): the
 * plugin rewrites the {@code build()} call sites it instruments, and a client
 * built inside this package is not one of them (on a device with the plugin
 * applied, such a client carried no interceptor, so probing here would warn on
 * every correctly set-up app).
 *
 * <p>This checks a proxy: RN's {@code createClient()}, not the per-request
 * {@code newBuilder().build()} call site inside NetworkingModule. A custom
 * client factory living in a package the plugin excludes can therefore give a
 * rare false warning; it is a log line only. An app's registered
 * {@code OkHttpClientFactory} also runs once more, at the first launch(), as a
 * side effect of the probe. That is deliberate: the factory's own build() is
 * where the plugin's interceptor would be, so probing the default path instead
 * would say nothing about the client JS really uses.
 */
public final class NetworkCaptureProbe {

    private static final String TAG = "BugseeRN";

    /** The class the plugin's injection adds (bugsee-android-okhttp). */
    static final String INTERCEPTOR_CLASS = "com.bugsee.library.okhttp.BugseeOkHttpInterceptor";

    static final String MESSAGE =
            "JS fetch/XHR network events will not be recorded: the Bugsee Gradle plugin "
                    + "(com.bugsee.android.gradle) is not applied to this app, or its OkHttp "
                    + "instrumentation is disabled or excluded, so no Bugsee interceptor is on "
                    + "React Native's OkHttp client. The same plugin uploads "
                    + "the R8 mapping and native symbols. See the Android: Bugsee Gradle plugin "
                    + "section of the @bugsee/react-native README.";

    private static final AtomicBoolean PROBED = new AtomicBoolean(false);

    private NetworkCaptureProbe() {}

    /**
     * Whether a client from {@code clientSource} carries the Bugsee interceptor. False only
     * when a client was built and none of its interceptors is Bugsee's. A
     * probe that cannot run (OkHttp missing, the build threw) is no evidence
     * either way and answers true, so it never warns by mistake.
     */
    static boolean isInstrumented(@NonNull final Callable<OkHttpClient> clientSource) {
        final List<String> names = new ArrayList<>();
        try {
            final OkHttpClient client = clientSource.call();
            collect(names, client.interceptors());
            collect(names, client.networkInterceptors());
        } catch (Throwable t) {
            return true;
        }
        return hasBugseeInterceptor(names);
    }

    /** True when {@code classNames} includes the plugin-injected interceptor. */
    static boolean hasBugseeInterceptor(@NonNull final List<String> classNames) {
        return classNames.contains(INTERCEPTOR_CLASS);
    }

    private static void collect(final List<String> into, final List<Interceptor> interceptors) {
        for (final Interceptor interceptor : interceptors) {
            into.add(interceptor.getClass().getName());
        }
    }

    /** Test seam: forget that the warning was logged. */
    static void resetForTest() {
        PROBED.set(false);
    }

    /**
     * Probes the client from {@code clientSource} and logs {@link #MESSAGE} at
     * WARN if it is not instrumented. Runs at most once per process, so
     * repeated launches build no further throwaway clients. Returns whether it
     * logged.
     */
    static boolean warnOnceIfNotInstrumented(@NonNull final Callable<OkHttpClient> clientSource) {
        if (!PROBED.compareAndSet(false, true) || isInstrumented(clientSource)) {
            return false;
        }
        Log.w(TAG, MESSAGE);
        return true;
    }
}
