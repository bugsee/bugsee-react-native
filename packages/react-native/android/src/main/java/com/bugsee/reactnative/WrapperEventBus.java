package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import android.util.Log;

import java.util.concurrent.atomic.AtomicReference;

/**
 * Carries the SDK's lifecycle and status events from the wrapper to the React
 * Native bridge.
 *
 * <p>The two ends have different lifetimes, which is the whole reason this
 * exists. The wrapper is registered at process start by
 * {@link ReactNativeWrapperInitProvider}, before React Native has loaded, and
 * it is replaced again when {@code setWrapperInfo} runs. The bridge appears
 * later, can be torn down and recreated by a reload, and is absent entirely
 * during start-up. Wiring the wrapper directly to a module would mean either
 * dropping the module's events after a reload or holding a dead module alive.
 *
 * <p>Events that arrive with no bridge attached are dropped, deliberately and
 * without complaint: during start-up there is no JavaScript to deliver them
 * to, and queueing them would deliver a burst of stale lifecycle transitions
 * the moment JS appeared, which is worse than not delivering them at all. A
 * caller that needs the current state asks {@code getStatus}.
 */
final class WrapperEventBus {

    private static final String TAG = "BugseeRN";

    /** The prefix both SDKs put on every lifecycle event name. */
    private static final String LIFECYCLE_PREFIX = "com.bugsee.lifecycle.";

    /**
     * What the bridge implements to receive events.
     *
     * <p>Lifecycle only. Status transitions are DERIVED from this channel in
     * JavaScript rather than carried separately: Android exposes no status
     * listener at all, and iOS's {@code bugseeDidChangeStatus:} belongs to the
     * app's own delegate, so a second channel would have no source on either
     * platform.
     */
    interface Sink {
        void onLifecycleEvent(@NonNull String name, @Nullable String reportId);
    }

    private static final WrapperEventBus SHARED = new WrapperEventBus();

    @NonNull
    static WrapperEventBus shared() {
        return SHARED;
    }

    /**
     * Atomic because the SDK dispatches from its own background threads while
     * the bridge attaches and detaches from the React thread.
     */
    private final AtomicReference<Sink> sink = new AtomicReference<>();

    @Nullable
    Sink sink() {
        return sink.get();
    }

    void attach(@NonNull final Sink newSink) {
        sink.set(newSink);
    }

    /**
     * Detaches {@code stale} only if it is still the attached sink.
     *
     * <p>Identity-checked rather than an unconditional clear: a fast reload can
     * construct and attach the new module before the old one is torn down, and
     * an unconditional clear would then silence the live bridge.
     */
    void detach(@NonNull final Sink stale) {
        sink.compareAndSet(stale, null);
    }

    /**
     * Forwards a lifecycle event, with the SDK's {@code com.bugsee.lifecycle.}
     * prefix removed.
     *
     * <p>An unrecognised name is forwarded unchanged rather than dropped. A
     * newer SDK adding an event must not have it silently swallowed by an older
     * wrapper: that hides a whole feature, and the JS side can decide what to
     * do with a name it does not know.
     */
    void emitLifecycle(@NonNull final String rawName, @Nullable final String reportId) {
        final Sink current = sink.get();
        if (current == null) {
            return;
        }

        final String name = rawName.startsWith(LIFECYCLE_PREFIX)
                ? rawName.substring(LIFECYCLE_PREFIX.length())
                : rawName;

        // A dead bridge throws from the emit, and this runs on the SDK's
        // dispatch thread: letting it escape would break the SDK's own
        // lifecycle handling for a fault that is entirely ours.
        try {
            current.onLifecycleEvent(name, reportId);
        } catch (final Throwable e) {
            Log.w(TAG, "Failed to deliver lifecycle event " + name, e);
        }
    }

}
