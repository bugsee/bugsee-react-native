package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * How long JS gets to handle one report callback, and whether it gets one.
 *
 * <p>Only the SDK's live dispatch thread reaches JS at all (see
 * {@link ReportHandlerBridge}). There the deadline sits INSIDE the SDK's
 * per-handler cap: past that cap the SDK proceeds without us, so a JS
 * deadline that overshoots it is not generous -- it lets JS keep writing to a
 * report that has already moved on.
 */
final class ReportHandlerDeadlines {

    /** 5 s inside the SDK's default 30 s per-handler cap. */
    static final long LIVE_DEADLINE_MS = 25_000L;

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

    /** Whether {@code threadName} is the SDK's live dispatch thread. */
    static boolean isLive(@NonNull final String threadName) {
        return LIVE_HANDLER_THREAD.equals(threadName);
    }
}
