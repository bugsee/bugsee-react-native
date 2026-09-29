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

    /** Counts release() calls; deliberately has no guard of its own. */
    private static final class FakeToken implements LayoutListenerToken {
        int releaseCalls;

        @Override
        public void release() {
            releaseCalls++;
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
        // Display 0 too, with an origin of its own: an abort that fell back to
        // a made-up reading would most likely land there (DEFAULT_DISPLAY is
        // what a missing Display reads as), so it must be observable there.
        store.setOrigin(0, 3, 4);
        store.set(0, new int[] { 1, 1, 2, 2 });
        final ReactRootOriginTracker tracker =
                new ReactRootOriginTracker(new FakeLifecycleSource(), finder, store);
        tracker.refresh();
        final int[] published7 = store.snapshot(7);
        final int[] published0 = store.snapshot(0);
        // Sanity: the first refresh really did publish (90, 20) on display 7,
        // and display 0 serves its own (3, 4) -- so "unchanged" below means
        // something on both.
        assertArrayEquals(new int[] { 100, 30, 110, 40 }, java.util.Arrays.copyOfRange(published7, 2, 6));
        assertArrayEquals(new int[] { 4, 5, 5, 6 }, java.util.Arrays.copyOfRange(published0, 2, 6));

        // Still reports itself attached (so refresh() does not look for a
        // new root) but gone by the time its location is actually resolved.
        rootHandle.viewGone = true;
        tracker.refresh();

        assertArrayEquals("display 7 must keep the origin it had", published7, store.snapshot(7));
        assertArrayEquals("display 0 must keep the origin it had", published0, store.snapshot(0));
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
    public void detachReleasesTheTokenCapturedAtRegistrationTimeExactlyOnce() {
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
        // fresh refresh(). detach() must release exactly the token handed
        // back when the listener was registered -- which observer that
        // removes from is the token's own business -- without registering
        // a new listener.
        rootHandle.attached = false;
        tracker.detach();

        assertEquals(1, token.releaseCalls);
        assertEquals("detach() must not re-register against the stale root",
                1, rootHandle.listenerRegistrations);

        // Idempotent: a second detach() (onHostDestroy() after dispose(),
        // say) must not release the same token twice. FakeToken has no guard
        // of its own, so this is the tracker's.
        tracker.detach();
        assertEquals(1, token.releaseCalls);
    }

    // The production token's own guard. Its removal logic proper -- saved
    // observer if alive, else the view's current one -- needs a real
    // ViewTreeObserver, which a plain JVM test cannot fake (final class,
    // stub android.jar), so only the guard it is built on is tested here.
    @Test
    public void aReleaseOnceTokenReleasesOnlyOnTheFirstCall() {
        final int[] releases = new int[1];
        final LayoutListenerToken token = new ReactRootOriginTracker.ReleaseOnceToken() {
            @Override
            void releaseNow() {
                releases[0]++;
            }
        };

        token.release();
        token.release();
        token.release();

        assertEquals(1, releases[0]);
    }

    // The production token's re-home decision, as a pure predicate: the
    // listener itself needs a real View/ViewTreeObserver, which a plain JVM
    // test cannot fake, so what feeds it is covered by review. A live saved
    // observer is always the one holding the listener (AOSP), so it is never
    // replaced -- re-homing it while the root sits in a different window
    // would aim release() at an observer that never held the listener. A
    // dead one is replaced only while the view is attached, because only
    // then is getViewTreeObserver() the window's observer that dispatches.
    @Test
    public void reHomesOnlyADeadObserverAndOnlyWhileTheViewIsAttached() {
        assertEquals("dead saved observer, view attached", true,
                ReactRootOriginTracker.shouldRehome(false, true));
        assertEquals("live saved observer, view attached (maybe elsewhere)", false,
                ReactRootOriginTracker.shouldRehome(true, true));
        assertEquals("dead saved observer, view detached", false,
                ReactRootOriginTracker.shouldRehome(false, false));
        assertEquals("live saved observer, view detached", false,
                ReactRootOriginTracker.shouldRehome(true, false));
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
                + "when a new root is found", 1, firstToken.releaseCalls);
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

    // Ruling I1: a window that moves WITHOUT a relayout (freeform, split
    // screen, PiP) fires no layout listener, and JS re-publishes nothing when
    // its measurement is unchanged. The SDK's own pull must bring the origin
    // up to date, so the pull after next serves the region where it now is.
    @Test
    public void aPullRefreshesTheOriginForTheNextPull() {
        final FakeRoot rootHandle = new FakeRoot();
        rootHandle.location = new int[] { 100, 40 };
        rootHandle.displayId = 7;
        final QueueRootFinder finder = new QueueRootFinder();
        finder.queue.add(rootHandle);
        final SecureRectangleStore store = new SecureRectangleStore();
        store.set(7, new int[] { 10, 10, 20, 20 });
        final ReactRootOriginTracker tracker =
                new ReactRootOriginTracker(new FakeLifecycleSource(), finder, store);
        tracker.refresh();

        // The UI thread, run by hand: the pull may only post to it.
        final java.util.Deque<Runnable> uiThread = new java.util.ArrayDeque<>();
        final long[] now = { 1_000 };
        final SecureRectanglePulls pulls = new SecureRectanglePulls(store, () -> now[0]);
        pulls.setRefresher(() -> uiThread.add(tracker::refresh));

        // The window moves; no layout pass follows.
        rootHandle.location = new int[] { 400, 300 };

        final int[] beforeRefresh = pulls.pull(7);
        assertArrayEquals(new int[] { 110, 50, 120, 60 }, java.util.Arrays.copyOfRange(beforeRefresh, 2, 6));
        now[0] += 10;
        pulls.pull(7);
        assertEquals(1, uiThread.size());

        uiThread.poll().run();

        final int[] afterRefresh = pulls.pull(7);
        assertArrayEquals(new int[] { 410, 310, 420, 320 }, java.util.Arrays.copyOfRange(afterRefresh, 2, 6));
    }
}
