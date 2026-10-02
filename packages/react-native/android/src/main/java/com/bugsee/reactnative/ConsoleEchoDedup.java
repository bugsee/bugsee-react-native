package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.internal.LogSource;

import java.util.ArrayDeque;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Drops the logcat echo of a console line the JS patch already sent through
 * the wrapper channel, before the user's log filter is asked.
 *
 * <p>React Native's console polyfill writes the same call to logcat under
 * the tag {@code ReactNativeJS}. The SDK's logcat reader then runs the log
 * filter on it, and the JS patch runs that filter again via the wrapper
 * channel. The channel line is the one that is kept: release builds do not
 * route {@code console.*} through {@code RCTLog}, so dropping the channel
 * line would drop the log. RN-internal lines use other tags and are kept;
 * on Android those already arrive through logcat, one filter pass, which is
 * why this class does not open a second capture of them.
 */
final class ConsoleEchoDedup {

    /** An echo that arrives later than this is a different line. */
    static final long WINDOW_MS = 2_000L;

    /** {@code reactAndroidLoggingHook} writes JS console lines under this tag. */
    static final String JS_CONSOLE_TAG = "ReactNativeJS";

    interface Clock {
        long now();
    }

    private final Clock clock;
    private final ConcurrentHashMap<String, ArrayDeque<Long>> credits = new ConcurrentHashMap<>();

    ConsoleEchoDedup(@NonNull final Clock clock) {
        this.clock = clock;
    }

    /** A wrapper-channel line is about to be filtered. Its logcat echo may follow. */
    void note(@Nullable final String message) {
        if (message == null) {
            return;
        }
        final long expiry = clock.now() + WINDOW_MS;
        final ArrayDeque<Long> queue = credits.computeIfAbsent(message, key -> new ArrayDeque<>());
        synchronized (queue) {
            queue.addLast(expiry);
        }
    }

    /**
     * True when this logcat line is an echo with a live credit. The credit
     * is consumed. Any other source or tag is kept, including a native
     * {@code ReactNative} logcat line.
     */
    boolean dropEcho(
            @NonNull final LogSource source,
            @Nullable final String tag,
            @Nullable final String message
    ) {
        if (source != LogSource.LogCat || !JS_CONSOLE_TAG.equals(tag) || message == null) {
            return false;
        }
        final ArrayDeque<Long> queue = credits.get(message);
        if (queue == null) {
            return false;
        }
        synchronized (queue) {
            final long now = clock.now();
            while (!queue.isEmpty()) {
                final Long expiry = queue.peekFirst();
                if (expiry == null || expiry <= now) {
                    queue.removeFirst();
                } else {
                    break;
                }
            }
            if (queue.isEmpty()) {
                credits.remove(message, queue);
                return false;
            }
            queue.removeFirst();
            if (queue.isEmpty()) {
                credits.remove(message, queue);
            }
            return true;
        }
    }
}
