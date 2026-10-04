package com.bugsee.reactnative;

import android.app.Activity;
import android.graphics.Point;
import android.util.Log;
import android.view.Display;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.UiThread;

import com.facebook.react.bridge.LifecycleEventListener;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.UiThreadUtil;
import com.facebook.react.uimanager.RootView;
import com.facebook.react.uimanager.RootViewUtil;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;

/**
 * Keeps {@link SecureRectangleStore}'s per-surface display origins in step
 * with each React root view, so rectangles JS measured with {@code
 * measureInWindow} are served to the SDK in display pixels.
 *
 * <p>The origin of a surface is that root's {@code getLocationOnScreen} less
 * React Native's own viewport offset for it ({@link
 * RootViewUtil#getViewportOffset}, the formula {@code ReactSurfaceView} feeds
 * Fabric's layout constraints, which is what {@code measureInWindow} adds to
 * a view's position in its root). With edge-to-edge on and a full-screen
 * window that is (0, 0); with it off, it is the status-bar/cutout inset; in
 * split-screen or freeform it is also the window's own position on the
 * display.
 *
 * <p>Fabric {@code measureInWindow} stops at the nearest {@code RootNodeKind}
 * ancestor ({@code ModalHostViewShadowNode} sets that trait), so a rectangle
 * inside a {@code <Modal>} is relative to the dialog's {@code
 * DialogRootViewGroup}, not the activity root. Each surface therefore has its
 * own origin; a single {@code setOrigin} for the display cannot serve both.
 *
 * <p>Re-read on every global layout of a watched root (rotation, insets
 * arriving, a window resize), on host resume, on every JS publish, and at
 * most every {@link SecureRectanglePulls#ORIGIN_REFRESH_MIN_INTERVAL_MS}
 * while the SDK pulls (a window can move without a relayout). All view access
 * is on the UI thread; the store is thread-safe.
 */
final class ReactRootOriginTracker implements LifecycleEventListener {

    private static final String TAG = "BugseeRN";

    private final LifecycleSource lifecycle;
    private final RootFinder rootFinder;
    private final SecureRectangleStore store;

    /** UI thread only: the activity React root, when found. */
    @Nullable
    private RootHandle root;

    /**
     * Extra surfaces (a {@code <Modal>}'s {@code DialogRootViewGroup})
     * registered via {@link #watch}, each paired with the layout-listener
     * token from {@link RootHandle#addOnGlobalLayoutListener}. UI thread only.
     */
    private final List<WatchedRoot> watched = new ArrayList<>();

    /**
     * The layout-listener registration for {@link #root}, if any, released
     * through this same token later. Which observer it is removed from is
     * the token's business (see {@link ViewTreeObserverToken}), not a fresh
     * lookup on the root: a root no longer attached to its window hands back
     * a different, "floating" observer, and removing from that one would
     * silently leak the real registration.
     */
    @Nullable
    private LayoutListenerToken layoutToken;

    /** A watched surface and the layout token that must be released with it. */
    private static final class WatchedRoot {
        final RootHandle handle;
        final LayoutListenerToken token;

        WatchedRoot(@NonNull final RootHandle handle,
                @NonNull final LayoutListenerToken token) {
            this.handle = handle;
            this.token = token;
        }
    }

    /**
     * A copy of the {@code {x, y}} last passed to {@link
     * SecureRectangleStore#setOrigin}, for {@link #currentOrigin()} (Task
     * 6.5's {@code vh} data request). UI thread only, like everything else
     * that is not explicitly annotated otherwise.
     */
    @Nullable
    private int[] lastOrigin;

    /**
     * Set once {@link #dispose()} is called, synchronously, so a
     * {@link #refreshSoon()} already queued on the UI thread -- or one
     * raced in just after -- still finds it set when it runs. Without this,
     * a refresh that lands between dispose() posting {@link #detach()} and
     * that detach actually running would re-find and re-register against
     * the root dispose() is in the middle of tearing down.
     */
    private volatile boolean disposed;

    ReactRootOriginTracker(@NonNull final ReactApplicationContext context,
            @NonNull final SecureRectangleStore store) {
        this(new ContextLifecycleSource(context), new ActivityRootFinder(context), store);
    }

    /**
     * Test seam. {@link ReactApplicationContext} needs a real Android
     * {@code Context} to construct, and {@link View}'s window/observer
     * behaviour cannot be faked in a plain JVM test -- {@link
     * ViewTreeObserver} is {@code final}, so even a stubbed instance cannot
     * be told to report itself alive or dead. {@link LifecycleSource} and
     * {@link RootFinder} let a test drive the dispose/attach/detach state
     * machine with plain Java fakes instead.
     */
    ReactRootOriginTracker(@NonNull final LifecycleSource lifecycle,
            @NonNull final RootFinder rootFinder, @NonNull final SecureRectangleStore store) {
        this.lifecycle = lifecycle;
        this.rootFinder = rootFinder;
        this.store = store;
        lifecycle.addLifecycleEventListener(this);
        refreshSoon();
    }

    /** Re-reads the origin on the UI thread. Safe from any thread. */
    void refreshSoon() {
        UiThreadUtil.runOnUiThread(this::refresh);
    }

    void dispose() {
        disposed = true;
        lifecycle.removeLifecycleEventListener(this);
        UiThreadUtil.runOnUiThread(this::detach);
    }

    @Override
    public void onHostResume() {
        refresh();
    }

    @Override
    public void onHostPause() {
    }

    @Override
    public void onHostDestroy() {
        detach();
    }

    /**
     * Never throws: this runs from layout and lifecycle callbacks of the host
     * app, where an exception would crash it over a redaction offset.
     *
     * <p>Package-visible (rather than {@code private}) so a JVM test can call
     * it directly: posting through {@link UiThreadUtil} never actually runs
     * the posted runnable outside a real Android main-thread {@code Looper}.
     */
    @UiThread
    void refresh() {
        if (disposed) {
            return;
        }
        try {
            RootHandle current = root;
            if (current == null || !current.isAttachedToWindow()) {
                detachPrimary();
                current = rootFinder.findCurrentRoot();
                if (current != null) {
                    layoutToken = current.addOnGlobalLayoutListener(this::refresh);
                    root = current;
                }
            }

            if (current != null) {
                publishOrigin(current, true);
            }
            refreshWatched();
        } catch (Throwable t) {
            Log.w(TAG, "secure rectangles: could not read the React root's display origin: "
                    + t.getClass().getName());
        }
    }

    /**
     * Tracks an additional React root (a {@code <Modal>}'s dialog root) so
     * its display origin is refreshed with the activity root. Safe from any
     * thread: posts to the UI thread.
     */
    void watch(@NonNull final RootHandle handle) {
        UiThreadUtil.runOnUiThread(() -> watchNow(handle));
    }

    /** Package-visible for the same reason as {@link #refresh()}. */
    @UiThread
    void watchNow(@NonNull final RootHandle handle) {
        if (disposed) {
            return;
        }
        for (final WatchedRoot existing : watched) {
            if (existing.handle.surfaceKey() == handle.surfaceKey()) {
                return;
            }
        }
        final LayoutListenerToken token = handle.addOnGlobalLayoutListener(this::refresh);
        watched.add(new WatchedRoot(handle, token));
        publishOrigin(handle, false);
    }

    @UiThread
    private void refreshWatched() {
        final Iterator<WatchedRoot> it = watched.iterator();
        while (it.hasNext()) {
            final WatchedRoot entry = it.next();
            if (!entry.handle.isAttachedToWindow()) {
                it.remove();
                entry.token.release();
                continue;
            }
            publishOrigin(entry.handle, false);
        }
    }

    @UiThread
    private void publishOrigin(@NonNull final RootHandle handle, final boolean primary) {
        // Resolved once, atomically: the handle holds the root's view only
        // weakly, and reading location/viewport/display as separate calls
        // could see the view collected partway through, mixing a real value
        // read before that with a made-up default (0,0) / DEFAULT_DISPLAY
        // read after it -- publishing a wrong origin is a privacy defect,
        // not a cosmetic one, so a gone-mid-refresh view aborts the whole
        // read instead: nothing new is published and the previous origin
        // stands.
        final OriginSnapshot snapshot = handle.resolveOrigin();
        if (snapshot == null) {
            return;
        }
        final int[] origin =
                SecureRectangleStore.displayOrigin(snapshot.onScreen, snapshot.viewport.x, snapshot.viewport.y);
        store.setOrigin(snapshot.displayId, handle.surfaceKey(), origin[0], origin[1]);
        // Manual setSecureRectangles and legacy callers publish on
        // MAIN_SURFACE; mirror the activity root there so they keep working.
        if (primary && handle.surfaceKey() != SecureRectangleStore.MAIN_SURFACE) {
            store.setOrigin(snapshot.displayId, SecureRectangleStore.MAIN_SURFACE, origin[0], origin[1]);
        }
        if (primary) {
            lastOrigin = origin;
        }
        if (Log.isLoggable(TAG, Log.DEBUG)) {
            Log.d(TAG, "secure origin display=" + snapshot.displayId
                    + " surface=" + handle.surfaceKey()
                    + " onScreen=" + snapshot.onScreen[0] + "," + snapshot.onScreen[1]
                    + " viewport=" + snapshot.viewport.x + "," + snapshot.viewport.y
                    + " origin=" + origin[0] + "," + origin[1]
                    + " served=" + Arrays.toString(store.snapshot(snapshot.displayId)));
        }
    }

    /**
     * The React root's current display origin, for {@link DataRequestBridge}
     * (Task 6.5): the {@code vh} data request is answered on the same thread
     * the SDK asks on -- the main thread, per the spec -- so a synchronous
     * re-read here is safe and catches a window that moved without a layout
     * pass (Ruling I1), the same way a secure-rectangle pull does.
     *
     * <p>{@code null} before any root has ever been found -- an app that never
     * calls {@code Bugsee.wrap} answers every {@code vh} request natively,
     * which the spec allows.
     */
    @UiThread
    @Nullable
    int[] currentOrigin() {
        refresh();
        return lastOrigin == null ? null : lastOrigin.clone();
    }

    /** Package-visible for the same reason as {@link #refresh()}. */
    @UiThread
    void detach() {
        detachPrimary();
        for (final WatchedRoot entry : watched) {
            entry.token.release();
        }
        watched.clear();
    }

    @UiThread
    private void detachPrimary() {
        root = null;
        final LayoutListenerToken token = layoutToken;
        layoutToken = null;
        if (token != null) {
            token.release();
        }
    }

    /** What this class needs from the wrapper's {@link ReactApplicationContext}. */
    interface LifecycleSource {
        void addLifecycleEventListener(LifecycleEventListener listener);

        void removeLifecycleEventListener(LifecycleEventListener listener);
    }

    private static final class ContextLifecycleSource implements LifecycleSource {
        private final ReactApplicationContext context;

        ContextLifecycleSource(final ReactApplicationContext context) {
            this.context = context;
        }

        @Override
        public void addLifecycleEventListener(final LifecycleEventListener listener) {
            context.addLifecycleEventListener(listener);
        }

        @Override
        public void removeLifecycleEventListener(final LifecycleEventListener listener) {
            context.removeLifecycleEventListener(listener);
        }
    }

    /** Finds the current React root, if any. */
    interface RootFinder {
        @Nullable
        RootHandle findCurrentRoot();
    }

    /** What this class needs from the current React root and its window. */
    interface RootHandle {
        boolean isAttachedToWindow();

        /**
         * Opaque key for {@link SecureRectangleStore}'s per-surface origin.
         * The activity React root and a dialog root must not share one.
         */
        int surfaceKey();

        /**
         * The root's current on-screen location, viewport offset and display
         * id, resolved as one atomic snapshot -- or {@code null} if the
         * underlying view is no longer reachable. Reading these as separate
         * calls could resolve a weakly-held view once for one field and find
         * it already collected for the next, silently blending a real value
         * with a made-up default.
         */
        @Nullable
        OriginSnapshot resolveOrigin();

        /**
         * Registers a layout callback and returns the token that removes it
         * again, from whichever observer holds it by then.
         */
        LayoutListenerToken addOnGlobalLayoutListener(Runnable onLayout);
    }

    /** A root's location, viewport offset and display id, read together. */
    static final class OriginSnapshot {
        final int[] onScreen;
        final Point viewport;
        final int displayId;

        OriginSnapshot(final int[] onScreen, final Point viewport, final int displayId) {
            this.onScreen = onScreen;
            this.viewport = viewport;
            this.displayId = displayId;
        }
    }

    /** A layout-listener registration. UI thread only. */
    interface LayoutListenerToken {
        /** Removes the registration. Idempotent: only the first call does anything. */
        void release();
    }

    /**
     * The idempotency every production {@link LayoutListenerToken} shares:
     * {@link #releaseNow()} runs on the first {@link #release()} only.
     * Package-visible so a JVM test can check the guard itself.
     */
    abstract static class ReleaseOnceToken implements LayoutListenerToken {
        /** UI thread only, like every other call on a token. */
        private boolean released;

        @Override
        public final void release() {
            if (released) {
                return;
            }
            released = true;
            releaseNow();
        }

        abstract void releaseNow();
    }

    private static final class ActivityRootFinder implements RootFinder {
        private final ReactApplicationContext context;

        ActivityRootFinder(final ReactApplicationContext context) {
            this.context = context;
        }

        @Nullable
        @Override
        public RootHandle findCurrentRoot() {
            final Activity activity = context.getCurrentActivity();
            if (activity == null || activity.getWindow() == null) {
                return null;
            }
            final View view = firstRootView(activity.getWindow().getDecorView());
            return view == null ? null : new ViewRootHandle(view);
        }
    }

    @Nullable
    private static View firstRootView(@NonNull final View view) {
        if (view instanceof RootView) {
            return view;
        }
        if (view instanceof ViewGroup) {
            final ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                final View found = firstRootView(group.getChildAt(i));
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    /**
     * Production {@link RootHandle}, backed by a real {@link View}. Holds it
     * weakly, same as the field this replaced: the root belongs to an
     * activity that may die before {@link #dispose()} is called.
     */
    private static final class ViewRootHandle implements RootHandle {
        private final WeakReference<View> view;
        private final int surfaceKey;

        ViewRootHandle(final View view) {
            this.view = new WeakReference<>(view);
            this.surfaceKey = surfaceKeyOf(view);
        }

        /**
         * React tags for RootViews are positive; {@link View#NO_ID} falls
         * back to identity so two untagged roots still stay apart.
         */
        static int surfaceKeyOf(@NonNull final View view) {
            final int id = view.getId();
            return id != View.NO_ID ? id : System.identityHashCode(view);
        }

        @Nullable
        private View view() {
            return view.get();
        }

        @Override
        public boolean isAttachedToWindow() {
            final View v = view();
            return v != null && v.isAttachedToWindow();
        }

        @Override
        public int surfaceKey() {
            return surfaceKey;
        }

        @Nullable
        @Override
        public OriginSnapshot resolveOrigin() {
            final View v = view();
            if (v == null) {
                return null;
            }
            final int[] onScreen = new int[2];
            v.getLocationOnScreen(onScreen);
            final Point viewport = RootViewUtil.getViewportOffset(v);
            final Display display = v.getDisplay();
            final int displayId = display == null ? Display.DEFAULT_DISPLAY : display.getDisplayId();
            return new OriginSnapshot(onScreen, viewport, displayId);
        }

        @Override
        public LayoutListenerToken addOnGlobalLayoutListener(final Runnable onLayout) {
            final View v = view();
            if (v == null) {
                return NoOpToken.INSTANCE;
            }
            return new ViewTreeObserverToken(v, onLayout);
        }
    }

    /**
     * Builds a {@link RootHandle} for an already-resolved React root view
     * (the activity root or a dialog's {@code DialogRootViewGroup}) and
     * starts watching it. Package-visible so {@link BugseeModule} can
     * register a surface when JS resolves {@code secureSurfaceKey}.
     */
    @Nullable
    static RootHandle handleFor(@Nullable final View rootView) {
        return rootView == null ? null : new ViewRootHandle(rootView);
    }

    /**
     * The surface key {@link SecureRectangleStore} and JS share for {@code
     * rootView}. Package-visible for {@link BugseeModule#secureSurfaceKey}.
     */
    static int surfaceKeyOf(@NonNull final View rootView) {
        return ViewRootHandle.surfaceKeyOf(rootView);
    }

    /**
     * Whether {@link ViewTreeObserverToken}'s listener should replace its
     * saved observer with the view's current one: only a cleared or dead
     * saved observer, and only while the view is attached. Pure, so a JVM
     * test can check the decision itself.
     */
    static boolean shouldRehome(final boolean savedAlive, final boolean viewAttached) {
        return !savedAlive && viewAttached;
    }

    /**
     * A layout listener on a real {@link View}, and the one place that knows
     * which {@link ViewTreeObserver} it has to be removed from.
     *
     * <p>That is not simply "the observer it was added to". A listener added
     * before the view is attached goes onto a "floating" observer; on attach,
     * Android merges it into the window's observer and kills the floating
     * one. And a detached view's {@code getViewTreeObserver()} hands back a
     * floating observer again, not the window's that still holds the
     * listener. So the observer reference is re-homed from inside the
     * listener, when {@link #shouldRehome} says so: only once the saved
     * observer is gone or dead (a live one is always the observer holding
     * the listener, even if the view has since moved to another window), and
     * only while the view is attached -- only a window's observer ever
     * dispatches a global layout ({@code ViewRootImpl} calls it on
     * {@code mAttachInfo.mTreeObserver}), and while the view is attached,
     * that is exactly what its {@code getViewTreeObserver()} returns.
     * Otherwise the saved reference stands -- which is what lets a root
     * replaced inside a live window still be removed from that window's
     * observer.
     *
     * <p>The view and the observer are held weakly: a live observer
     * transitively pins the view, and so the activity, and this token can
     * outlive both
     * {@link #dispose()} (which posts detach() to the UI thread) and a host
     * reload.
     */
    private static final class ViewTreeObserverToken extends ReleaseOnceToken {
        private final WeakReference<View> view;
        private final ViewTreeObserver.OnGlobalLayoutListener listener;
        /** UI thread only: re-homed by {@link #listener}, read by release. */
        private WeakReference<ViewTreeObserver> observer;

        ViewTreeObserverToken(@NonNull final View v, @NonNull final Runnable onLayout) {
            this.view = new WeakReference<>(v);
            this.listener = () -> {
                // Before onLayout: that may detach(), and so release this.
                final ViewTreeObserver saved = observer.get();
                final View current = view.get();
                if (current != null
                        && shouldRehome(saved != null && saved.isAlive(), current.isAttachedToWindow())) {
                    observer = new WeakReference<>(current.getViewTreeObserver());
                }
                onLayout.run();
            };
            final ViewTreeObserver o = v.getViewTreeObserver();
            this.observer = new WeakReference<>(o);
            o.addOnGlobalLayoutListener(listener);
        }

        /**
         * From the saved observer if it is alive; otherwise -- it was the
         * floating one, killed by the merge on attach before any layout could
         * re-home it -- from the view's current observer, if that is alive.
         * A dead observer throws on any call but {@code isAlive()}.
         */
        @Override
        void releaseNow() {
            final ViewTreeObserver saved = observer.get();
            if (saved != null && saved.isAlive()) {
                saved.removeOnGlobalLayoutListener(listener);
                return;
            }
            final View v = view.get();
            if (v == null) {
                return;
            }
            final ViewTreeObserver current = v.getViewTreeObserver();
            if (current.isAlive()) {
                current.removeOnGlobalLayoutListener(listener);
            }
        }
    }

    private enum NoOpToken implements LayoutListenerToken {
        INSTANCE;

        @Override
        public void release() {
        }
    }
}
