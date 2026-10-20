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

    @Before
    public void reset() {
        NetworkCaptureProbe.resetForTest();
    }

    @Test
    public void interceptorNameIsAClassTheSdkShips() throws Exception {
        // A renamed class in a later SDK would turn the probe into a false alarm.
        assertEquals(
                NetworkCaptureProbe.INTERCEPTOR_CLASS,
                Class.forName(NetworkCaptureProbe.INTERCEPTOR_CLASS).getName());
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
    public void warnsOncePerProcessOnlyWhenNotInstrumented() {
        assertFalse(NetworkCaptureProbe.warnOnceIfNotInstrumented(NetworkCaptureProbeTest::withBugsee));
        assertTrue(NetworkCaptureProbe.warnOnceIfNotInstrumented(NetworkCaptureProbeTest::plain));
        assertFalse(NetworkCaptureProbe.warnOnceIfNotInstrumented(NetworkCaptureProbeTest::plain));
        NetworkCaptureProbe.resetForTest();
        assertTrue(NetworkCaptureProbe.warnOnceIfNotInstrumented(NetworkCaptureProbeTest::plain));
    }

    @Test
    public void messageNamesThePluginAndTheConsequence() {
        assertTrue(NetworkCaptureProbe.MESSAGE.contains("com.bugsee.android.gradle"));
        assertTrue(NetworkCaptureProbe.MESSAGE.contains("fetch/XHR"));
    }
}
