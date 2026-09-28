package com.bugsee.reactnative;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.graphics.Point;

import com.bugsee.reactnative.ReactRootOriginTracker.LayoutListenerToken;
import com.bugsee.reactnative.ReactRootOriginTracker.LifecycleSource;
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
        Point viewport = new Point(0, 0);
        int displayId;
        int listenerRegistrations;
        FakeToken lastToken;

        @Override
        public boolean isAttachedToWindow() {
            return attached;
        }

        @Override
        public void getLocationOnScreen(final int[] outLocation) {
            outLocation[0] = location[0];
            outLocation[1] = location[1];
        }

        @Override
        public Point viewportOffset() {
            return viewport;
        }

        @Override
        public int displayId() {
            return displayId;
        }

        @Override
        public LayoutListenerToken addOnGlobalLayoutListener(final Runnable onLayout) {
            listenerRegistrations++;
            lastToken = new FakeToken();
            return lastToken;
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
        rootHandle.viewport = new Point();
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
        // handed back when the listener was registered, without asking the
        // (now stale) root for anything at all: a bug that instead asked the
        // root to look up "its" observer again would find a different,
        // unrelated one, so this asserts on the same FakeToken instance.
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

    @Test
    public void detachDoesNotReleaseATokenThatReportsItselfAlreadyDead() {
        final FakeRoot rootHandle = new FakeRoot();
        final QueueRootFinder finder = new QueueRootFinder();
        finder.queue.add(rootHandle);
        final ReactRootOriginTracker tracker =
                new ReactRootOriginTracker(new FakeLifecycleSource(), finder, new SecureRectangleStore());
        tracker.refresh();
        rootHandle.lastToken.alive = false;

        tracker.detach();

        assertEquals(0, rootHandle.lastToken.removeCalls);
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

        assertTrue("the stale root's token must be released once a new root is found",
                firstToken.removeCalls >= 1);
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
