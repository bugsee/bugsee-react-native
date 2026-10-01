package com.bugsee.reactnative;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * An unhandled report must start while a handled call is still blocked. JS
 * gives up on the fatal path after 1500 ms.
 */
public class ExceptionExecutorsTest {

    @Test
    public void unhandledDoesNotWaitForABlockedHandledCall() throws Exception {
        final CountDownLatch handledRunning = new CountDownLatch(1);
        final CountDownLatch releaseHandled = new CountDownLatch(1);
        ExceptionExecutors.HANDLED.execute(() -> {
            handledRunning.countDown();
            try {
                releaseHandled.await(5, TimeUnit.SECONDS);
            } catch (final InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        try {
            assertTrue(handledRunning.await(2, TimeUnit.SECONDS));
            final long started = System.nanoTime();
            final CountDownLatch unhandledRan = new CountDownLatch(1);
            ExceptionExecutors.UNHANDLED.execute(unhandledRan::countDown);
            assertTrue(unhandledRan.await(500, TimeUnit.MILLISECONDS));
            final long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
            assertTrue("unhandled waited " + elapsedMs + " ms behind handled", elapsedMs < 1500);
        } finally {
            releaseHandled.countDown();
        }
    }
}
