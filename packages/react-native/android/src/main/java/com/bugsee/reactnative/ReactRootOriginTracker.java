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
final class ReactRootOriginTracker
        implements LifecycleEventListener, ViewTreeObserver.OnGlobalLayoutListener {

    private static final String TAG = "BugseeRN";

    private final ReactApplicationContext context;
    private final SecureRectangleStore store;

    /** UI thread only. Weak: the root belongs to an activity that may die first. */
    @Nullable
    private WeakReference<View> root;

    ReactRootOriginTracker(@NonNull final ReactApplicationContext context,
            @NonNull final SecureRectangleStore store) {
        this.context = context;
        this.store = store;
        context.addLifecycleEventListener(this);
        refreshSoon();
    }

    /** Re-reads the origin on the UI thread. Safe from any thread. */
    void refreshSoon() {
        UiThreadUtil.runOnUiThread(this::refresh);
    }

    void dispose() {
        context.removeLifecycleEventListener(this);
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

    @Override
    public void onGlobalLayout() {
        refresh();
    }

    /**
     * Never throws: this runs from layout and lifecycle callbacks of the host
     * app, where an exception would crash it over a redaction offset.
     */
    @UiThread
    private void refresh() {
        try {
            View current = root == null ? null : root.get();
            if (current == null || !current.isAttachedToWindow()) {
                detach();
                current = findRoot();
                if (current == null) {
                    return;
                }
                current.getViewTreeObserver().addOnGlobalLayoutListener(this);
                root = new WeakReference<>(current);
            }

            final int[] onScreen = new int[2];
            current.getLocationOnScreen(onScreen);
            final Point viewport = RootViewUtil.getViewportOffset(current);
            final int[] origin = SecureRectangleStore.displayOrigin(onScreen, viewport.x, viewport.y);
            final Display display = current.getDisplay();
            final int displayId = display == null ? Display.DEFAULT_DISPLAY : display.getDisplayId();
            store.setOrigin(displayId, origin[0], origin[1]);
            if (Log.isLoggable(TAG, Log.DEBUG)) {
                Log.d(TAG, "secure origin display=" + displayId
                        + " onScreen=" + onScreen[0] + "," + onScreen[1]
                        + " viewport=" + viewport.x + "," + viewport.y
                        + " origin=" + origin[0] + "," + origin[1]
                        + " served=" + Arrays.toString(store.snapshot(displayId)));
            }
        } catch (Throwable t) {
            Log.w(TAG, "secure rectangles: could not read the React root's display origin", t);
        }
    }

    @UiThread
    private void detach() {
        final View previous = root == null ? null : root.get();
        root = null;
        if (previous != null) {
            final ViewTreeObserver observer = previous.getViewTreeObserver();
            if (observer.isAlive()) {
                observer.removeOnGlobalLayoutListener(this);
            }
        }
    }

    @Nullable
    @UiThread
    private View findRoot() {
        final Activity activity = context.getCurrentActivity();
        if (activity == null || activity.getWindow() == null) {
            return null;
        }
        return firstRootView(activity.getWindow().getDecorView());
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
}
