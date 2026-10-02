package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.contracts.internal.LogSource;

import org.junit.Test;

import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.atomic.AtomicReference;

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

    @Test
    public void aThirtyThirdDistinctMessageDoesNotGrowTheMapWithoutBound() {
        for (int i = 0; i < ConsoleEchoDedup.MAX_MESSAGES + 1; i++) {
            dedup.note("m" + i);
        }
        assertTrue(dedup.size() <= ConsoleEchoDedup.MAX_MESSAGES);
        assertEquals(ConsoleEchoDedup.MAX_MESSAGES, dedup.size());
        assertFalse(dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "m0"));
        assertTrue(dedup.dropEcho(
                LogSource.LogCat,
                ConsoleEchoDedup.JS_CONSOLE_TAG,
                "m" + ConsoleEchoDedup.MAX_MESSAGES));
    }

    @Test
    public void anExpiredCreditIsGoneAfterTheNextNote() {
        dedup.note("old");
        now += ConsoleEchoDedup.WINDOW_MS;
        dedup.note("fresh");
        assertEquals(1, dedup.size());
        assertFalse(dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "old"));
        assertTrue(dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "fresh"));
    }

    /**
     * {@code dropEcho} may remove the deque while {@code note} is about to
     * append. The new credit has to land in the map, so the next echo is
     * still dropped.
     */
    @Test
    public void aNoteRacingTheLastDropKeepsTheNewCreditInTheMap() throws Exception {
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        for (int i = 0; i < 400; i++) {
            dedup.note("race");
            final CyclicBarrier start = new CyclicBarrier(2);
            final Thread dropper = new Thread(() -> race(start, failure, () ->
                    dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "race")));
            final Thread noter = new Thread(() -> race(start, failure, () -> dedup.note("race")));
            dropper.start();
            noter.start();
            dropper.join();
            noter.join();
            assertTrue(
                    "iteration " + i,
                    dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "race"));
            assertFalse(dedup.dropEcho(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "race"));
        }
        assertTrue(failure.get() == null);
    }

    private static void race(
            final CyclicBarrier start,
            final AtomicReference<Throwable> failure,
            final Runnable body
    ) {
        try {
            start.await();
            body.run();
        } catch (final Throwable thrown) {
            failure.set(thrown);
        }
    }
}
