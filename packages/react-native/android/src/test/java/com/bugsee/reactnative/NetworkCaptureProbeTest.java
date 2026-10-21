package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;

import okhttp3.OkHttpClient;
import com.bugsee.library.okhttp.BugseeOkHttpInterceptor;

import org.junit.Before;
import org.junit.Test;

public class NetworkCaptureProbeTest {

    // INTERCEPTOR_CLASS is pinned to the SDK's real class by
    // clientWithTheInjectedInterceptorIsInstrumented (addIfAbsent adds that
    // class, and the probe matches it by name). That the Gradle plugin injects
    // this same class into RN's client is only verified by the device run
    // (plugin on: no warning; plugin off: one warning).

    @Before
    public void reset() {
        NetworkCaptureProbe.resetForTest();
    }

    private static OkHttpClient plain() {
        return new OkHttpClient.Builder().build();
    }

    private static OkHttpClient withBugsee() {
        // What the Gradle plugin's rewritten build() call does to a builder.
        return BugseeOkHttpInterceptor.addIfAbsent(new OkHttpClient.Builder()).build();
    }

    @Test
    public void plainClientIsNotInstrumented() {
        assertFalse(NetworkCaptureProbe.isInstrumented(NetworkCaptureProbeTest::plain));
    }

    @Test
    public void clientWithTheInjectedInterceptorIsInstrumented() {
        assertTrue(NetworkCaptureProbe.isInstrumented(NetworkCaptureProbeTest::withBugsee));
    }

    @Test
    public void aProbeThatCannotRunIsNoEvidence() {
        assertTrue(NetworkCaptureProbe.isInstrumented(() -> {
            throw new IllegalStateException("no client");
        }));
        assertTrue(NetworkCaptureProbe.isInstrumented(() -> {
            throw new NoClassDefFoundError("okhttp3");
        }));
    }

    @Test
    public void recognisesTheInjectedInterceptorAmongOthers() {
        assertTrue(NetworkCaptureProbe.hasBugseeInterceptor(
                Arrays.asList("a.B", NetworkCaptureProbe.INTERCEPTOR_CLASS)));
        assertFalse(NetworkCaptureProbe.hasBugseeInterceptor(Arrays.asList("a.B", "com.bugsee.Other")));
        assertFalse(NetworkCaptureProbe.hasBugseeInterceptor(Collections.<String>emptyList()));
    }

    @Test
    public void warnsWhenNotInstrumented() {
        assertTrue(NetworkCaptureProbe.warnOnceIfNotInstrumented(NetworkCaptureProbeTest::plain));
    }

    @Test
    public void staysQuietWhenInstrumented() {
        assertFalse(NetworkCaptureProbe.warnOnceIfNotInstrumented(NetworkCaptureProbeTest::withBugsee));
    }

    @Test
    public void probesAtMostOncePerProcess() {
        final int[] built = {0};
        final java.util.concurrent.Callable<OkHttpClient> counting = () -> {
            built[0]++;
            return plain();
        };
        assertTrue(NetworkCaptureProbe.warnOnceIfNotInstrumented(counting));
        assertFalse(NetworkCaptureProbe.warnOnceIfNotInstrumented(counting));
        assertFalse(NetworkCaptureProbe.warnOnceIfNotInstrumented(counting));
        assertEquals(1, built[0]);
        NetworkCaptureProbe.resetForTest();
        assertTrue(NetworkCaptureProbe.warnOnceIfNotInstrumented(counting));
        assertEquals(2, built[0]);
    }

    @Test
    public void messageNamesThePluginAndTheConsequence() {
        assertTrue(NetworkCaptureProbe.MESSAGE.contains("com.bugsee.android.gradle"));
        assertTrue(NetworkCaptureProbe.MESSAGE.contains("fetch/XHR"));
        assertTrue(NetworkCaptureProbe.MESSAGE.contains("disabled or excluded"));
    }
}
