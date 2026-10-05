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
 * holds at most {@link #MAX_MESSAGES} messages, and one message at most
 * {@link #MAX_MESSAGES} credits, so at most 32 x 32 credits in all. That is
 * looser than iOS, where {@code BGSRNEchoNoteCap} caps all notes at 32. Every
 * cap fails toward a second filter call, never a lost line: a burst of more
 * than 32 identical lines, or 32 newer distinct ones, before the logcat reader
 * drains them lets the oldest echoes through.
 */
final class ConsoleEchoDedup {

    /** An echo that arrives later than this is a different line. */
    static final long WINDOW_MS = 2_000L;

    /**
     * Distinct messages remembered at once. A further distinct message drops
     * the oldest key. It is also the most
     * credits one message holds: a further note of it drops its oldest credit.
     */
    static final int MAX_MESSAGES = 32;

    /** {@code reactAndroidLoggingHook} writes JS console lines under this tag. */
    static final String JS_CONSOLE_TAG = "ReactNativeJS";

    interface Clock {
        long now();
    }

    private final Clock clock;
    private final ConcurrentHashMap<String, ArrayDeque<Long>> credits = new ConcurrentHashMap<>();
    /**
     * One entry per live key, oldest first. Guarded by itself. A key leaves
     * this deque when its last credit is consumed or expires, so a later
     * {@link #note} cannot append a second copy, and {@link #trimToCap}
     * cannot treat that copy as a reason to delete a live credit.
     */
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
        credits.compute(message, (key, queue) -> {
            final ArrayDeque<Long> next = queue == null ? new ArrayDeque<>() : queue;
            discardExpired(next, now);
            next.addLast(expiry);
            while (next.size() > MAX_MESSAGES) {
                next.removeFirst();
            }
            return next;
        });
        syncOrder(message);
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
        syncOrder(message);
        return dropped[0];
    }

    /** How many distinct messages still hold a credit. Tests assert the cap. */
    int size() {
        return credits.size();
    }

    /** How many order entries exist. One per live key; tests reject a stale copy. */
    int orderSize() {
        synchronized (notedOrder) {
            return notedOrder.size();
        }
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
            syncOrder(key);
        }
    }

    /**
     * Drops the oldest live keys until the map is within {@link #MAX_MESSAGES}.
     * A polled entry that is a second listing of a key still in the deque is
     * stale: it is discarded and the live credit stays. Eviction runs inside
     * {@code compute}, so it cannot delete a credit a concurrent {@link #note}
     * has just attached to a different deque.
     */
    private void trimToCap() {
        synchronized (notedOrder) {
            while (credits.size() > MAX_MESSAGES) {
                final String oldest = notedOrder.pollFirst();
                if (oldest == null) {
                    return;
                }
                if (notedOrder.contains(oldest) || !credits.containsKey(oldest)) {
                    continue;
                }
                credits.compute(oldest, (key, queue) -> null);
            }
        }
    }

    /**
     * One listing while {@code message} is in the map, and none once its last
     * credit is gone. Extra copies are dropped. A missing live key is appended.
     */
    private void syncOrder(@NonNull final String message) {
        synchronized (notedOrder) {
            final boolean live = credits.containsKey(message);
            boolean seen = false;
            final ArrayDeque<String> next = new ArrayDeque<>();
            for (final String key : notedOrder) {
                if (!message.equals(key)) {
                    next.addLast(key);
                    continue;
                }
                if (live && !seen) {
                    next.addLast(key);
                    seen = true;
                }
            }
            if (live && !seen) {
                next.addLast(message);
            }
            notedOrder.clear();
            notedOrder.addAll(next);
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
