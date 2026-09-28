package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * How long JS gets to handle one report callback.
 *
 * <p>Every value here sits INSIDE the SDK's own cap for the path the callback
 * arrived on (see the {@code ReportHandler} Javadoc). Past that cap the SDK
 * proceeds without us, so a JS deadline that overshoots it is not generous --
 * it lets JS keep writing to a report that has already moved on.
 */
final class ReportHandlerDeadlines {

    /** 5 s inside the SDK's default 30 s per-handler cap. */
    static final long LIVE_DEADLINE_MS = 25_000L;

    /**
     * 0.5 s inside the 3 s the SDK waits on every crash-adjacent path:
     * early-crash recovery, and the inline fallbacks when no SDK thread could
     * be had.
     */
    static final long RECOVERY_DEADLINE_MS = 2_500L;

    /**
     * Below this a round trip to JS and back cannot reliably fit, so the
     * handler is completed at once instead of racing a deadline it will lose.
     */
    static final long MIN_USEFUL_DEADLINE_MS = 1_000L;

    /**
     * The SDK's dedicated dispatch thread, and the ONLY thread the healthy,
     * long-cap path runs on (it keeps this name when the SDK recycles it).
     * Matched by name because the SDK tells a handler nothing else about which
     * path it is on.
     */
    static final String LIVE_HANDLER_THREAD = "BugseeReportHandlerThread";

    private ReportHandlerDeadlines() {
    }

    /**
     * The live deadline for the {@code ReportHandlerCallbackTimeout} option, in
     * seconds.
     *
     * <p>{@code null} (unreadable) and {@code 0} (per-handler timer disabled;
     * the SDK's 60 s chain cap still applies) both mean the default. The SDK
     * normalises a negative value to {@code 0}, and so does this. Otherwise a
     * second under the option, never more than the default.
     */
    static long liveMs(@Nullable final Integer optionSeconds) {
        if (optionSeconds == null || optionSeconds <= 0) {
            return LIVE_DEADLINE_MS;
        }
        return Math.min(LIVE_DEADLINE_MS, optionSeconds * 1000L - 1000L);
    }

    /** {@code liveMs} on the SDK's dispatch thread; the short cap anywhere else. */
    static long forThread(@NonNull final String threadName, final long liveMs) {
        return LIVE_HANDLER_THREAD.equals(threadName) ? liveMs : RECOVERY_DEADLINE_MS;
    }
}
