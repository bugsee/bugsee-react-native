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
import java.util.Arrays;

/**
 * Keeps {@link SecureRectangleStore}'s display origin in step with the React
 * root view, so rectangles JS measured with {@code measureInWindow} are served
 * to the SDK in display pixels.
 *
 * <p>The origin is the root's {@code getLocationOnScreen} less React Native's
 * own viewport offset for it ({@link RootViewUtil#getViewportOffset}, the
 * formula {@code ReactSurfaceView} feeds Fabric's layout constraints, which is
 * what {@code measureInWindow} adds to a view's position in its root). With
 * edge-to-edge on and a full-screen window that is (0, 0); with it off, it is
 * the status-bar/cutout inset; in split-screen or freeform it is also the
 * window's own position on the display.
 *
 * <p>Re-read on every global layout of the root (rotation, insets arriving,
 * a window resize), on host resume, and on every JS publish. All view access is
 * on the UI thread; the store is thread-safe.
 */
final class ReactRootOriginTracker implements LifecycleEventListener {

    private static final String TAG = "BugseeRN";

    private final LifecycleSource lifecycle;
    private final RootFinder rootFinder;
    private final SecureRectangleStore store;

    /** UI thread only. */
    @Nullable
    private RootHandle root;

    /**
     * The layout-listener registration for {@link #root}, if any. Saved at
     * registration time and released through this same token later -- a
     * root that is no longer attached to its window hands back a different,
     * "floating" observer from a fresh lookup, and releasing through that
     * one instead would silently target the wrong observer, leaking the
     * registration on the original.
     */
    @Nullable
    private LayoutListenerToken layoutToken;

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
                detach();
                current = rootFinder.findCurrentRoot();
                if (current == null) {
                    return;
                }
                layoutToken = current.addOnGlobalLayoutListener(this::refresh);
                root = current;
            }

            // Resolved once, atomically: current holds the root's view only
            // weakly, and reading location/viewport/display as separate
            // calls could see the view collected partway through, mixing a
            // real value read before that with a made-up default (0,0) /
            // DEFAULT_DISPLAY read after it -- publishing a wrong origin is
            // a privacy defect, not a cosmetic one, so a gone-mid-refresh
            // view aborts the whole read instead: nothing new is published
            // and the previous origin stands.
            final OriginSnapshot snapshot = current.resolveOrigin();
            if (snapshot == null) {
                return;
            }
            final int[] origin =
                    SecureRectangleStore.displayOrigin(snapshot.onScreen, snapshot.viewport.x, snapshot.viewport.y);
            store.setOrigin(snapshot.displayId, origin[0], origin[1]);
            if (Log.isLoggable(TAG, Log.DEBUG)) {
                Log.d(TAG, "secure origin display=" + snapshot.displayId
                        + " onScreen=" + snapshot.onScreen[0] + "," + snapshot.onScreen[1]
                        + " viewport=" + snapshot.viewport.x + "," + snapshot.viewport.y
                        + " origin=" + origin[0] + "," + origin[1]
                        + " served=" + Arrays.toString(store.snapshot(snapshot.displayId)));
            }
        } catch (Throwable t) {
            Log.w(TAG, "secure rectangles: could not read the React root's display origin", t);
        }
    }

    /** Package-visible for the same reason as {@link #refresh()}. */
    @UiThread
    void detach() {
        final RootHandle previousRoot = root;
        root = null;
        final LayoutListenerToken token = layoutToken;
        layoutToken = null;
        if (token == null) {
            return;
        }
        if (previousRoot != null) {
            // The root, not the token, releases it: a listener registered
            // while the root was not yet attached to a window went onto a
            // "floating" ViewTreeObserver, which Android kills once the
            // real registration is merged into the window's observer on
            // attach -- the token's own observer then reports itself dead,
            // and only the root (which still holds the view) can find the
            // observer that is actually live now to remove it from instead.
            previousRoot.releaseGlobalLayoutListener(token);
        } else {
            token.remove();
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
         * Registers a layout callback and returns a token bound to the exact
         * observer live right now.
         */
        LayoutListenerToken addOnGlobalLayoutListener(Runnable onLayout);

        /**
         * Releases {@code token}, falling back to this root's own,
         * currently-live listener registration if the token's own observer
         * no longer reports itself alive (see {@link ViewTreeObserverToken}).
         */
        void releaseGlobalLayoutListener(LayoutListenerToken token);
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

    /** A layout-listener registration, releasable from the exact observer it was made on. */
    interface LayoutListenerToken {
        boolean isAlive();

        void remove();
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

        /**
         * The listener currently registered through {@link
         * #addOnGlobalLayoutListener}, if any -- kept here (not only inside
         * the token handed back) so {@link #releaseGlobalLayoutListener} can
         * remove it from whatever observer this root considers current now,
         * not only the one it was originally registered on.
         */
        @Nullable
        private ViewTreeObserver.OnGlobalLayoutListener registeredListener;

        ViewRootHandle(final View view) {
            this.view = new WeakReference<>(view);
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
            final ViewTreeObserver observer = v.getViewTreeObserver();
            final ViewTreeObserver.OnGlobalLayoutListener listener = onLayout::run;
            observer.addOnGlobalLayoutListener(listener);
            registeredListener = listener;
            return new ViewTreeObserverToken(observer, listener);
        }

        @Override
        public void releaseGlobalLayoutListener(final LayoutListenerToken token) {
            if (token.isAlive()) {
                token.remove();
                return;
            }
            // The observer the token was registered on is dead: normal once
            // a listener is registered before the view is attached to a
            // window (onHostResume can fire before the decor view is
            // attached) and the view attaches afterwards -- Android merges
            // that registration into the window's ViewTreeObserver and kills
            // the "floating" one it was made on. What is still live, if
            // anything, is this view's CURRENT observer.
            final View v = view();
            final ViewTreeObserver.OnGlobalLayoutListener listener = registeredListener;
            if (v == null || listener == null) {
                return;
            }
            final ViewTreeObserver current = v.getViewTreeObserver();
            if (current.isAlive()) {
                current.removeOnGlobalLayoutListener(listener);
            }
        }
    }

    /**
     * Holds the {@link ViewTreeObserver} it registered on weakly: a live
     * observer transitively pins the view, and so the activity, and this
     * token can outlive both dispose() (which posts detach() to the UI
     * thread) and a host reload. If it has been collected there is nothing
     * left to remove the listener from through this token specifically --
     * {@link ViewRootHandle#releaseGlobalLayoutListener} is what falls back
     * to the view's current observer in that case.
     */
    private static final class ViewTreeObserverToken implements LayoutListenerToken {
        private final WeakReference<ViewTreeObserver> observer;
        private final ViewTreeObserver.OnGlobalLayoutListener listener;

        ViewTreeObserverToken(final ViewTreeObserver observer,
                final ViewTreeObserver.OnGlobalLayoutListener listener) {
            this.observer = new WeakReference<>(observer);
            this.listener = listener;
        }

        @Override
        public boolean isAlive() {
            final ViewTreeObserver o = observer.get();
            return o != null && o.isAlive();
        }

        @Override
        public void remove() {
            final ViewTreeObserver o = observer.get();
            if (o != null) {
                o.removeOnGlobalLayoutListener(listener);
            }
        }
    }

    private enum NoOpToken implements LayoutListenerToken {
        INSTANCE;

        @Override
        public boolean isAlive() {
            return false;
        }

        @Override
        public void remove() {
        }
    }
}
