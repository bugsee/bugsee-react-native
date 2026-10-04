package com.bugsee.reactnative;

import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.exchange.NetworkEvent;
import com.bugsee.library.contracts.internal.BugseeWrapperChannel;
import com.bugsee.library.contracts.internal.LogSource;
import com.bugsee.library.contracts.options.LogLevel;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The SDK's wrapper channel, held for the whole process.
 *
 * <p>The channel is how this wrapper submits what it captured in JS -- log
 * lines now, network events and breadcrumbs later -- attributed as wrapper
 * data rather than as the app's own calls. It is delivered to whichever
 * {@link BugseeReactNativeWrapper} is registered, but it lives here rather
 * than on that instance: the wrapper is replaced when {@code setWrapperInfo}
 * refines the identity, and the SDK hands the replacement a fresh channel.
 * The last one delivered is the live one; an earlier one is inert.
 *
 * <p>Nothing is buffered. A channel held before {@code launch} accepts and
 * drops what it is given, which is the spec'd behaviour, not an error.
 *
 * <p>Every line sent through here is filtered natively by the app's log
 * filter, once; this wrapper never runs that filter in JS (design doc
 * &sect;10.3). The channel's {@code log} has no flag to say otherwise.
 */
final class WrapperChannelHolder {

    private static final String TAG = "BugseeRN";

    /** Where a filter fault is reported. Logcat in production; injectable for tests. */
    interface Diagnostics {
        void report(@NonNull String message, @NonNull Throwable error);
    }

    private static final WrapperChannelHolder SHARED =
            new WrapperChannelHolder((message, error) ->
                    Log.w(TAG, message + ": " + error.getClass().getName()));

    @NonNull
    static WrapperChannelHolder shared() {
        return SHARED;
    }

    private final Diagnostics diagnostics;
    private final AtomicReference<BugseeWrapperChannel> channel = new AtomicReference<>();
    // One per producer: a shared flag would hide the second filter's fault
    // once the first had fired.
    private final AtomicBoolean logFaultReported = new AtomicBoolean();
    private final AtomicBoolean networkFaultReported = new AtomicBoolean();

    WrapperChannelHolder(@NonNull final Diagnostics diagnostics) {
        this.diagnostics = diagnostics;
    }

    /**
     * Called from inside {@code Bugsee.setWrapper}, under the SDK's
     * registration lock: a plain store, and nothing that could block.
     */
    void set(@NonNull final BugseeWrapperChannel delivered) {
        channel.set(delivered);
    }

    /** After {@code setWrapper(null)}, which retires the channel SDK-side too. */
    void clear() {
        channel.set(null);
    }

    /**
     * One JS line, as source {@code Custom} with no tag.
     *
     * <p>The tag stays null because iOS has nowhere to put one, and a line
     * must read the same on both platforms. The source is always set here,
     * never left to the SDK, which on iOS would read a missing one as
     * {@code Unknown}.
     *
     * <p>The app's filter runs on this thread, and on Android an exception it
     * throws comes back here. This thread is React Native's, where an escaping
     * exception is a crash, so it stops here and is reported once per process:
     * the report is itself a logcat line, which the SDK's logcat capture can
     * feed back into the same filter.
     */
    void log(@Nullable final String message, final int level) {
        final BugseeWrapperChannel current = channel.get();
        if (current == null) {
            return;
        }
        try {
            current.log(null, message, levelFor(level), LogSource.Custom);
        } catch (final Throwable e) {
            if (logFaultReported.compareAndSet(false, true)) {
                diagnostics.report("the app's log filter threw on a wrapper log line "
                        + "(reported once per process)", e);
            }
        }
    }

    /**
     * Always {@code requiresFiltering = true}. {@code false} skips the SDK's
     * built-in network sanitizer as well as the app's filter, and nothing this
     * wrapper sends has been through either.
     */
    void addNetworkEvent(@Nullable final NetworkEvent event) {
        final BugseeWrapperChannel current = channel.get();
        if (current == null) {
            return;
        }
        try {
            current.addNetworkEvent(event, true);
        } catch (final Throwable e) {
            if (networkFaultReported.compareAndSet(false, true)) {
                diagnostics.report("the app's network filter threw on a wrapper network event "
                        + "(reported once per process)", e);
            }
        }
    }

    /**
     * By value, the table both platforms share: 1 Error ... 5 Verbose, and
     * anything else Info. Never {@code values()[n]} -- Error is value 1 at
     * ordinal 0. Range-checked before the byte cast, which would otherwise
     * wrap 257 round to 1.
     */
    static LogLevel levelFor(final int wire) {
        if (wire < 1 || wire > 5) {
            return LogLevel.Info;
        }
        return LogLevel.fromRawValue((byte) wire, LogLevel.Info);
    }
}
