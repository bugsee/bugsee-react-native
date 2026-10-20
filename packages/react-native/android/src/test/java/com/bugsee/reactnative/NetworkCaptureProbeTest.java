package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;

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

    @Test
    public void plainClientHasNoBugseeInterceptor() {
        // The Gradle plugin does not run in unit tests, so a client built here
        // is exactly what a bare app gets.
        assertFalse(NetworkCaptureProbe.isInstrumented());
    }

    @Test
    public void recognisesTheInjectedInterceptorAmongOthers() {
        assertTrue(NetworkCaptureProbe.hasBugseeInterceptor(
                Arrays.asList("a.B", NetworkCaptureProbe.INTERCEPTOR_CLASS)));
        assertFalse(NetworkCaptureProbe.hasBugseeInterceptor(Arrays.asList("a.B", "com.bugsee.Other")));
        assertFalse(NetworkCaptureProbe.hasBugseeInterceptor(Collections.<String>emptyList()));
    }

    @Test
    public void warnsOncePerProcess() {
        assertTrue(NetworkCaptureProbe.warnOnceIfNotInstrumented());
        assertFalse(NetworkCaptureProbe.warnOnceIfNotInstrumented());
        NetworkCaptureProbe.resetForTest();
        assertTrue(NetworkCaptureProbe.warnOnceIfNotInstrumented());
    }

    @Test
    public void messageNamesThePluginAndTheConsequence() {
        assertTrue(NetworkCaptureProbe.MESSAGE.contains("com.bugsee.android.gradle"));
        assertTrue(NetworkCaptureProbe.MESSAGE.contains("fetch/XHR"));
    }
}
