package com.bugsee.reactnative;

import android.util.Log;

import androidx.annotation.NonNull;

import java.util.ArrayList;
import java.util.List;
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
 */
public final class NetworkCaptureProbe {

    private static final String TAG = "BugseeRN";

    /** The class the plugin's injection adds (bugsee-android-okhttp). */
    static final String INTERCEPTOR_CLASS = "com.bugsee.library.okhttp.BugseeOkHttpInterceptor";

    static final String MESSAGE =
            "JS fetch/XHR network events will not be recorded: the Bugsee Gradle plugin "
                    + "(com.bugsee.android.gradle) is not applied to this app, so no Bugsee "
                    + "interceptor is on React Native's OkHttp client. The same plugin uploads "
                    + "the R8 mapping and native symbols. See the Android: Bugsee Gradle plugin "
                    + "section of the @bugsee/react-native README.";

    private static final AtomicBoolean WARNED = new AtomicBoolean(false);

    private NetworkCaptureProbe() {}

    /**
     * Whether a client built now carries the Bugsee interceptor. False only
     * when a client was built and none of its interceptors is Bugsee's. A
     * probe that cannot run (OkHttp missing, the build threw) is no evidence
     * either way and answers true, so it never warns by mistake.
     */
    static boolean isInstrumented() {
        final List<String> names = new ArrayList<>();
        try {
            final OkHttpClient client = new OkHttpClient.Builder().build();
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
        WARNED.set(false);
    }

    /** Logs {@link #MESSAGE} at WARN, at most once per process, if not instrumented. */
    static boolean warnOnceIfNotInstrumented() {
        if (isInstrumented() || !WARNED.compareAndSet(false, true)) {
            return false;
        }
        Log.w(TAG, MESSAGE);
        return true;
    }
}
