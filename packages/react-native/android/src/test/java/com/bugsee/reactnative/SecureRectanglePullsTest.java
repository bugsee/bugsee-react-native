package com.bugsee.reactnative;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * The SDK's pull is what keeps the React root's display origin fresh when the
 * window moves without a relayout (freeform, split-screen, PiP). JS no longer
 * re-publishes an unchanged measurement, so nothing else would: a pull that
 * stops asking serves every region at the window's old position.
 */
public class SecureRectanglePullsTest {

    private static final class FakeClock implements SecureRectanglePulls.Clock {
        long now;

        @Override
        public long nowMs() {
            return now;
        }
    }

    private static final class CountingRefresher implements Runnable {
        int calls;

        @Override
        public void run() {
            calls++;
        }
    }

    private final SecureRectangleStore store = new SecureRectangleStore();
    private final FakeClock clock = new FakeClock();
    private final SecureRectanglePulls pulls = new SecureRectanglePulls(store, clock);

    @Test
    public void aPullSchedulesARefreshAndServesTheStore() {
        final CountingRefresher refresher = new CountingRefresher();
        pulls.setRefresher(refresher);
        store.set(3, new int[] { 1, 2, 3, 4 });

        final int[] served = pulls.pull(3);

        assertEquals(1, refresher.calls);
        assertArrayEquals(store.snapshot(3), served);
    }

    @Test
    public void repeatedPullsInsideTheThrottleWindowScheduleOnlyOne() {
        final CountingRefresher refresher = new CountingRefresher();
        pulls.setRefresher(refresher);
        clock.now = 5_000;

        pulls.pull(0);
        clock.now += 50;
        pulls.pull(0);
        pulls.pull(1);
        clock.now += SecureRectanglePulls.ORIGIN_REFRESH_MIN_INTERVAL_MS - 51;
        pulls.pull(0);
        assertEquals(1, refresher.calls);

        clock.now += 1;
        pulls.pull(0);
        assertEquals(2, refresher.calls);
    }

    @Test
    public void theFirstPullAsksWhateverTheClockReads() {
        final CountingRefresher refresher = new CountingRefresher();
        pulls.setRefresher(refresher);
        // System.nanoTime() may be negative.
        clock.now = -7_000;

        pulls.pull(0);

        assertEquals(1, refresher.calls);
    }

    @Test
    public void withNoRefresherAPullStillServesTheStore() {
        store.set(0, new int[] { 5, 6, 7, 8 });

        assertArrayEquals(store.snapshot(0), pulls.pull(0));
    }

    // Nothing may escape into the SDK's pull thread, and the snapshot is
    // served regardless.
    @Test
    public void aRefresherThatThrowsStillServesTheStore() {
        pulls.setRefresher(() -> {
            throw new IllegalStateException("no looper");
        });
        store.set(0, new int[] { 5, 6, 7, 8 });

        assertArrayEquals(store.snapshot(0), pulls.pull(0));
    }

    // A reload installs the new module's refresher before the old module is
    // invalidated; the old one's clear must not remove the new one.
    @Test
    public void clearingRemovesOnlyTheRefresherItNames() {
        final CountingRefresher stale = new CountingRefresher();
        final CountingRefresher live = new CountingRefresher();
        pulls.setRefresher(stale);
        pulls.setRefresher(live);

        pulls.clearRefresher(stale);
        pulls.pull(0);
        assertEquals(1, live.calls);
        assertEquals(0, stale.calls);

        pulls.clearRefresher(live);
        clock.now += SecureRectanglePulls.ORIGIN_REFRESH_MIN_INTERVAL_MS;
        pulls.pull(0);
        assertEquals(1, live.calls);
    }
}
