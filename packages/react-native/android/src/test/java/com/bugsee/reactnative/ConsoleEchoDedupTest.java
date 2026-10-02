package com.bugsee.reactnative;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.contracts.internal.LogSource;

import org.junit.Test;

/**
 * The logcat echo of a console line is dropped only while a wrapper-channel
 * credit for that text is live. A native logcat line, and an echo that
 * arrives with no credit, are kept.
 */
public class ConsoleEchoDedupTest {

    private long now = 1_000L;
    private final ConsoleEchoDedup dedup = new ConsoleEchoDedup(() -> now);

    @Test
    public void aReactNativeJsLineMatchingAChannelLineIsDropped() {
        dedup.note("BUGSEE_E2E dedup");
        assertTrue(dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "BUGSEE_E2E dedup"));
    }

    @Test
    public void theSameEchoIsKeptOnceItsCreditIsSpent() {
        dedup.note("once");
        assertTrue(dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "once"));
        assertFalse(dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "once"));
    }

    @Test
    public void aNativeReactNativeTagIsKept() {
        dedup.note("module failed");
        assertFalse(dedup.dropEcho(LogSource.LogCat, "ReactNative", "module failed"));
    }

    @Test
    public void aChannelLineIsNotAnEcho() {
        dedup.note("from the patch");
        assertFalse(dedup.dropEcho(LogSource.Custom, ConsoleEchoDedup.JS_CONSOLE_TAG, "from the patch"));
    }

    @Test
    public void anEchoWithNoCreditIsKept() {
        assertFalse(dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "unclaimed"));
    }

    @Test
    public void anEchoAfterTheWindowIsKept() {
        dedup.note("late");
        now += ConsoleEchoDedup.WINDOW_MS;
        assertFalse(dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "late"));
    }

    @Test
    public void anEchoInsideTheWindowIsDropped() {
        dedup.note("soon");
        now += ConsoleEchoDedup.WINDOW_MS - 1;
        assertTrue(dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "soon"));
    }
}
