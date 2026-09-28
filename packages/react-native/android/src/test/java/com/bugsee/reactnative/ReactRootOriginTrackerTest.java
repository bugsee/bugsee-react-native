package com.bugsee.reactnative;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import android.graphics.Point;

import com.bugsee.reactnative.ReactRootOriginTracker.LayoutListenerToken;
import com.bugsee.reactnative.ReactRootOriginTracker.LifecycleSource;
import com.bugsee.reactnative.ReactRootOriginTracker.OriginSnapshot;
import com.bugsee.reactnative.ReactRootOriginTracker.RootFinder;
import com.bugsee.reactnative.ReactRootOriginTracker.RootHandle;
import com.facebook.react.bridge.LifecycleEventListener;

import org.junit.Test;

/**
 * {@link ReactRootOriginTracker} depends on {@link
 * com.facebook.react.bridge.ReactApplicationContext} (needs a real Android
 * {@code Context} to construct) and on {@code View}/{@code
 * ViewTreeObserver} (the latter is {@code final}, so a plain JVM test cannot
 * even sub-class it to report itself alive or dead). None of that is
 * available without Robolectric, which this module does not use, so these
 * tests drive the class through its {@link LifecycleSource}/{@link
 * RootFinder} seam with hand-written fakes instead.
 */
public class ReactRootOriginTrackerTest {

    /** Records add/remove calls; never actually delivers a lifecycle event. */
    private static final class FakeLifecycleSource implements LifecycleSource {
        int added;
        int removed;

        @Override
        public void addLifecycleEventListener(final LifecycleEventListener listener) {
            added++;
        }

        @Override
        public void removeLifecycleEventListener(final LifecycleEventListener listener) {
            removed++;
        }
    }

    private static final class FakeToken implements LayoutListenerToken {
        boolean alive = true;
        int removeCalls;

        @Override
        public boolean isAlive() {
            return alive;
        }

        @Override
        public void remove() {
            removeCalls++;
        }
    }

    private static final class FakeRoot implements RootHandle {
        boolean attached = true;
        int[] location = { 0, 0 };
        Point viewport = new Point();
        int displayId;
        /** Simulates the weakly-held view having been collected mid-refresh. */
        boolean viewGone;
        int listenerRegistrations;
        FakeToken lastToken;
        /**
         * What {@link #releaseGlobalLayoutListener} finds and removes when
         * the token it is asked to release reports its own observer dead --
         * standing in for "this root's current registration", the way
         * production re-fetches the view's current ViewTreeObserver.
         */
        FakeToken fallbackToken;
        int fallbackReleaseCalls;

        @Override
        public boolean isAttachedToWindow() {
            return attached;
        }

        @Override
        public OriginSnapshot resolveOrigin() {
            if (viewGone) {
                return null;
            }
            return new OriginSnapshot(new int[] { location[0], location[1] }, viewport, displayId);
        }

        @Override
        public LayoutListenerToken addOnGlobalLayoutListener(final Runnable onLayout) {
            listenerRegistrations++;
            lastToken = new FakeToken();
            return lastToken;
        }

        @Override
        public void releaseGlobalLayoutListener(final LayoutListenerToken token) {
            if (token.isAlive()) {
                token.remove();
                return;
            }
            fallbackReleaseCalls++;
            if (fallbackToken != null) {
                fallbackToken.remove();
            }
        }
    }

    /** Hands out roots from a fixed queue, then null once it is empty. */
    private static final class QueueRootFinder implements RootFinder {
        final java.util.Deque<RootHandle> queue = new java.util.ArrayDeque<>();
        int calls;

        @Override
        public RootHandle findCurrentRoot() {
            calls++;
            return queue.pollFirst();
        }
    }

    @Test
    public void findsARootAndPublishesItsOrigin() {
        final FakeRoot rootHandle = new FakeRoot();
        rootHandle.location = new int[] { 100, 40 };
        // Field writes, not the constructor: android.graphics.Point is a
        // platform class, and this module's unit tests run against a stub
        // android.jar (unitTests.returnDefaultValues) whose constructors are
        // stripped to no-ops -- new Point(10, 20) would silently leave x=y=0.
        rootHandle.viewport.x = 10;
        rootHandle.viewport.y = 20;
        rootHandle.displayId = 7;
        final QueueRootFinder finder = new QueueRootFinder();
        finder.queue.add(rootHandle);
        final SecureRectangleStore store = new SecureRectangleStore();
        // A rectangle already secured on display 7, so the origin refresh()
        // computes is observable in its translated coordinates -- setOrigin()
        // alone leaves no other visible trace in a snapshot.
        store.set(7, new int[] { 10, 10, 20, 20 });

        final ReactRootOriginTracker tracker =
                new ReactRootOriginTracker(new FakeLifecycleSource(), finder, store);
        tracker.refresh();

        assertEquals(1, rootHandle.listenerRegistrations);
        // origin = locationOnScreen - viewport = (100 - 10, 40 - 20) = (90, 20).
        final int[] snapshot = store.snapshot(7);
        assertEquals(1, snapshot[1]);
        assertArrayEquals(new int[] { 100, 30, 110, 40 }, java.util.Arrays.copyOfRange(snapshot, 2, 6));
    }

    // The privacy-sensitive case: the root is weakly held, and reading its
    // location/viewport/display as three separate calls could resolve the
    // view for one and find it collected for the next, blending a real
    // value with a made-up default into a WRONG origin. resolveOrigin()
    // resolves the view once and returns null if it is gone by then; refresh()
    // must abort and publish nothing rather than accept a partial reading.
    @Test
    public void refreshPublishesNothingWhenTheRootIsGoneMidRefresh() {
        final FakeRoot rootHandle = new FakeRoot();
        rootHandle.location = new int[] { 100, 40 };
        rootHandle.viewport.x = 10;
        rootHandle.viewport.y = 20;
        rootHandle.displayId = 7;
        final QueueRootFinder finder = new QueueRootFinder();
        finder.queue.add(rootHandle);
        final SecureRectangleStore store = new SecureRectangleStore();
        store.set(7, new int[] { 10, 10, 20, 20 });
        final ReactRootOriginTracker tracker =
                new ReactRootOriginTracker(new FakeLifecycleSource(), finder, store);
        tracker.refresh();
        final int[] published = store.snapshot(7);

        // Still reports itself attached (so refresh() does not look for a
        // new root) but gone by the time its location is actually resolved.
        rootHandle.viewGone = true;
        tracker.refresh();

        assertArrayEquals(published, store.snapshot(7));
    }

    @Test
    public void disposeStopsRefreshFromDoingAnything() {
        final FakeLifecycleSource lifecycle = new FakeLifecycleSource();
        final QueueRootFinder finder = new QueueRootFinder();
        finder.queue.add(new FakeRoot());
        final SecureRectangleStore store = new SecureRectangleStore();
        final ReactRootOriginTracker tracker =
                new ReactRootOriginTracker(lifecycle, finder, store);

        tracker.dispose();
        assertEquals(1, lifecycle.removed);
        finder.calls = 0;

        // A refresh posted before dispose(), or racing in just after it, must
        // still no-op once disposed is set -- it must not look for a root at
        // all, let alone find and re-attach to the one queued above.
        tracker.refresh();

        assertEquals(0, finder.calls);
    }

    @Test
    public void detachReleasesTheTokenCapturedAtRegistrationTime() {
        final FakeRoot rootHandle = new FakeRoot();
        final QueueRootFinder finder = new QueueRootFinder();
        finder.queue.add(rootHandle);
        final ReactRootOriginTracker tracker =
                new ReactRootOriginTracker(new FakeLifecycleSource(), finder, new SecureRectangleStore());
        tracker.refresh();
        final FakeToken token = rootHandle.lastToken;
        assertEquals(1, rootHandle.listenerRegistrations);

        // The root is no longer attached to its window -- as it would be
        // once its activity is torn down -- and only detach() runs, not a
        // fresh refresh(). A correct detach() must release exactly the token
        // handed back when the listener was registered (here, the token's
        // own observer is still alive, so the root removes through it
        // directly), without registering a new listener.
        rootHandle.attached = false;
        tracker.detach();

        assertEquals(1, token.removeCalls);
        assertEquals("detach() must not re-register against the stale root",
                1, rootHandle.listenerRegistrations);

        // Idempotent: a second detach() (onHostDestroy() after dispose(),
        // say) must not release the same token twice.
        tracker.detach();
        assertEquals(1, token.removeCalls);
    }

    // The real bug this guards: a listener registered before the view is
    // attached to a window goes onto a "floating" ViewTreeObserver; Android
    // merges it into the window's observer on attach and kills the floating
    // one, so the saved token's own observer reports itself dead. The old
    // code then simply skipped removal, leaking the registration (and, via
    // it, the window observer keeping the listener, the tracker and the
    // ReactApplicationContext alive) on every such attach. The fix asks the
    // ROOT to release the token, so it can fall back to whatever it
    // considers its current, live registration.
    @Test
    public void detachRemovesThroughTheRootsCurrentRegistrationWhenTheSavedObserverHasDied() {
        final FakeRoot rootHandle = new FakeRoot();
        final QueueRootFinder finder = new QueueRootFinder();
        finder.queue.add(rootHandle);
        final ReactRootOriginTracker tracker =
                new ReactRootOriginTracker(new FakeLifecycleSource(), finder, new SecureRectangleStore());
        tracker.refresh();
        final FakeToken savedToken = rootHandle.lastToken;
        savedToken.alive = false;
        final FakeToken currentRegistration = new FakeToken();
        rootHandle.fallbackToken = currentRegistration;

        tracker.detach();

        assertEquals("a dead saved observer must never be asked to remove anything",
                0, savedToken.removeCalls);
        assertEquals(1, rootHandle.fallbackReleaseCalls);
        assertEquals("removal must go through the root's current registration instead",
                1, currentRegistration.removeCalls);
    }

    @Test
    public void refreshFindsANewRootOnceTheOldOneIsGone() {
        final FakeRoot first = new FakeRoot();
        final FakeRoot second = new FakeRoot();
        second.displayId = 9;
        final QueueRootFinder finder = new QueueRootFinder();
        finder.queue.add(first);
        finder.queue.add(second);
        final ReactRootOriginTracker tracker =
                new ReactRootOriginTracker(new FakeLifecycleSource(), finder, new SecureRectangleStore());
        tracker.refresh();
        final FakeToken firstToken = first.lastToken;

        first.attached = false;
        tracker.refresh();

        assertEquals("the stale root's token must be released exactly once, "
                + "when a new root is found", 1, firstToken.removeCalls);
        assertEquals(1, second.listenerRegistrations);
    }

    @Test
    public void refreshDoesNothingWhenNoRootCanBeFound() {
        final QueueRootFinder finder = new QueueRootFinder();
        final ReactRootOriginTracker tracker =
                new ReactRootOriginTracker(new FakeLifecycleSource(), finder, new SecureRectangleStore());

        tracker.refresh();

        assertEquals(1, finder.calls);
    }

    @Test
    public void constructorRegistersAsALifecycleListener() {
        final FakeLifecycleSource lifecycle = new FakeLifecycleSource();
        new ReactRootOriginTracker(lifecycle, new QueueRootFinder(), new SecureRectangleStore());

        assertEquals(1, lifecycle.added);
        assertEquals(0, lifecycle.removed);
    }
}
