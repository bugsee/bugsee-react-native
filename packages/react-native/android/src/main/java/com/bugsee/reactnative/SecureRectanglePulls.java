package com.bugsee.reactnative;

import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Serves the SDK's secure-rectangle pull, and uses each pull to keep the
 * React root's display origin fresh.
 *
 * <p>The served rectangles are JS's measurements moved by the root's display
 * origin, which {@link ReactRootOriginTracker} re-reads on a global layout, on
 * resume and on a JS publish. None of those fires when the window moves
 * without a relayout (freeform or desktop windowing, split-screen
 * repositioning, picture-in-picture), and JS publishes only when a measurement
 * changes. So the SDK's own pull, 2-3 times a second, also asks for a refresh.
 * The refresh runs on the UI thread and lands in the store, and the NEXT pull
 * serves it: a moved window is corrected within about one pull interval,
 * whatever JS does. Without this, the region would be served at the window's
 * old position and recorded in the clear where it now is.
 *
 * <p>The pull runs on the SDK's thread and must never block or throw there.
 * Asking for a refresh only posts to the UI thread, at most once every
 * {@link #ORIGIN_REFRESH_MIN_INTERVAL_MS}, and a failure to ask is logged and
 * swallowed: the snapshot is served regardless.
 *
 * <p>Process-wide, like {@link SecureRectangleStore}: the wrapper the SDK pulls
 * through is replaced mid-session, while the refresher belongs to whichever
 * {@code BugseeModule} is live.
 */
final class SecureRectanglePulls {

    private static final String TAG = "BugseeRN";

    /** The fastest the pull asks for an origin refresh. */
    static final long ORIGIN_REFRESH_MIN_INTERVAL_MS = 100;

    /** Milliseconds from a monotonic source. Injectable for tests. */
    interface Clock {
        long nowMs();
    }

    /** Before the first request: the first pull always asks. */
    private static final long NEVER = Long.MIN_VALUE;

    private static final SecureRectanglePulls SHARED = new SecureRectanglePulls(
            SecureRectangleStore.shared(), () -> System.nanoTime() / 1_000_000L);

    @NonNull
    static SecureRectanglePulls shared() {
        return SHARED;
    }

    private final SecureRectangleStore store;
    private final Clock clock;
    private final AtomicReference<Runnable> refresher = new AtomicReference<>();
    private final AtomicLong lastRequestMs = new AtomicLong(NEVER);

    SecureRectanglePulls(@NonNull final SecureRectangleStore store, @NonNull final Clock clock) {
        this.store = store;
        this.clock = clock;
    }

    /**
     * Installs what a pull calls to ask for an origin refresh. It must only
     * post to the UI thread, never touch a view itself: it runs on the SDK's
     * pull thread.
     */
    void setRefresher(@NonNull final Runnable newRefresher) {
        refresher.set(newRefresher);
    }

    /**
     * Removes {@code expected}, if it is still the one installed. A reload can
     * install the new module's refresher before the old module is
     * invalidated, and an unconditional clear would then stop the live one.
     */
    void clearRefresher(@NonNull final Runnable expected) {
        refresher.compareAndSet(expected, null);
    }

    /** The SDK's pull: the buffer for {@code display}, after asking for a refresh. */
    @NonNull
    int[] pull(final int display) {
        requestOriginRefresh();
        return store.snapshot(display);
    }

    private void requestOriginRefresh() {
        final Runnable current = refresher.get();
        if (current == null) {
            return;
        }
        final long now = clock.nowMs();
        final long last = lastRequestMs.get();
        if (last != NEVER && now - last < ORIGIN_REFRESH_MIN_INTERVAL_MS) {
            return;
        }
        // One winner per window when the SDK pulls several displays at once.
        if (!lastRequestMs.compareAndSet(last, now)) {
            return;
        }
        try {
            current.run();
        } catch (Throwable t) {
            Log.w(TAG, "secure rectangles: could not schedule an origin refresh", t);
        }
    }
}
