package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.internal.LogSource;

import java.util.ArrayDeque;
import java.util.ArrayList;
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
 *
 * <p>Credits for one message live in the map under that message. A note and
 * a drop of the same message both update that entry with {@code compute}, so
 * a credit is never appended to a deque the map has already dropped. The map
 * itself is capped at {@link #MAX_MESSAGES}, the same bound as iOS
 * {@code BGSRNEchoNoteCap}.
 */
final class ConsoleEchoDedup {

    /** An echo that arrives later than this is a different line. */
    static final long WINDOW_MS = 2_000L;

    /**
     * Distinct messages remembered at once. Matches iOS {@code BGSRNEchoNoteCap}.
     * A further distinct message drops the oldest key.
     */
    static final int MAX_MESSAGES = 32;

    /** {@code reactAndroidLoggingHook} writes JS console lines under this tag. */
    static final String JS_CONSOLE_TAG = "ReactNativeJS";

    interface Clock {
        long now();
    }

    private final Clock clock;
    private final ConcurrentHashMap<String, ArrayDeque<Long>> credits = new ConcurrentHashMap<>();
    /** Insertion order of distinct messages. Guarded by itself. */
    private final ArrayDeque<String> notedOrder = new ArrayDeque<>();

    ConsoleEchoDedup(@NonNull final Clock clock) {
        this.clock = clock;
    }

    /** A wrapper-channel line is about to be filtered. Its logcat echo may follow. */
    void note(@Nullable final String message) {
        if (message == null) {
            return;
        }
        final long now = clock.now();
        final long expiry = now + WINDOW_MS;
        final boolean[] created = {false};
        credits.compute(message, (key, queue) -> {
            final ArrayDeque<Long> next = queue == null ? new ArrayDeque<>() : queue;
            if (queue == null) {
                created[0] = true;
            }
            discardExpired(next, now);
            next.addLast(expiry);
            return next;
        });
        if (created[0]) {
            synchronized (notedOrder) {
                notedOrder.addLast(message);
            }
        }
        sweep(now);
        trimToCap();
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
        final boolean[] dropped = {false};
        credits.compute(message, (key, queue) -> {
            if (queue == null) {
                return null;
            }
            discardExpired(queue, clock.now());
            if (queue.isEmpty()) {
                return null;
            }
            queue.removeFirst();
            dropped[0] = true;
            return queue.isEmpty() ? null : queue;
        });
        return dropped[0];
    }

    /** How many distinct messages still hold a credit. Tests assert the cap. */
    int size() {
        return credits.size();
    }

    private void sweep(final long now) {
        for (final String key : new ArrayList<>(credits.keySet())) {
            credits.compute(key, (ignored, queue) -> {
                if (queue == null) {
                    return null;
                }
                discardExpired(queue, now);
                return queue.isEmpty() ? null : queue;
            });
            if (!credits.containsKey(key)) {
                synchronized (notedOrder) {
                    notedOrder.remove(key);
                }
            }
        }
    }

    private void trimToCap() {
        int stale = 0;
        while (credits.size() > MAX_MESSAGES) {
            final String oldest;
            synchronized (notedOrder) {
                oldest = notedOrder.pollFirst();
            }
            if (oldest == null) {
                return;
            }
            if (credits.remove(oldest) == null) {
                stale += 1;
                if (stale > MAX_MESSAGES) {
                    return;
                }
            } else {
                stale = 0;
            }
        }
    }

    private static void discardExpired(@NonNull final ArrayDeque<Long> queue, final long now) {
        while (!queue.isEmpty()) {
            final Long expiry = queue.peekFirst();
            if (expiry != null && expiry > now) {
                return;
            }
            queue.removeFirst();
        }
    }
}
