package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.shared.threading.BugseeHandlers;

import org.junit.Test;

/**
 * The deadline JS gets for a handle must always land inside the SDK's own cap
 * for the path the handler is running on. Overshooting is not a softer
 * failure: the SDK proceeds without us, and whatever JS writes after that is
 * written to a report that has already moved on.
 */
public class ReportHandlerDeadlinesTest {

    /** The SDK's default per-handler cap is 30 s; we stop 5 s short of it. */
    @Test
    public void liveIs25sUnderTheDefault30sCap() {
        assertEquals(25_000L, ReportHandlerDeadlines.liveMs(null));
        assertEquals(25_000L, ReportHandlerDeadlines.liveMs(30));
        assertEquals(25_000L, ReportHandlerDeadlines.liveMs(120));
    }

    /** An app that lowered the cap gets a deadline a second under it. */
    @Test
    public void liveTracksALowerOption() {
        assertEquals(9_000L, ReportHandlerDeadlines.liveMs(10));
    }

    /**
     * 0 disables the SDK's per-handler timer; its 60 s chain cap still holds,
     * so the ordinary live deadline is safely inside it. A negative value is
     * normalised to 0 by the SDK, and reads the same here.
     */
    @Test
    public void zeroOptionMeans25s() {
        assertEquals(25_000L, ReportHandlerDeadlines.liveMs(0));
        assertEquals(25_000L, ReportHandlerDeadlines.liveMs(-5));
    }

    /** 1 s leaves no margin at all: the handler is completed, not raced. */
    @Test
    public void oneSecondOptionFallsBelowTheUsefulMinimum() {
        assertTrue(ReportHandlerDeadlines.liveMs(1) < ReportHandlerDeadlines.MIN_USEFUL_DEADLINE_MS);
        assertEquals(ReportHandlerDeadlines.MIN_USEFUL_DEADLINE_MS, ReportHandlerDeadlines.liveMs(2));
    }

    /** The crash-adjacent paths cap at 3 s; half a second of margin under that. */
    @Test
    public void recoveryIs2500() {
        assertEquals(2_500L, ReportHandlerDeadlines.RECOVERY_DEADLINE_MS);
    }

    /**
     * Only the SDK's dedicated dispatch thread is the healthy path. Every other
     * thread -- main during early-crash recovery, a recovery worker, anything
     * we do not recognise -- gets the short deadline, which is inside every
     * cap the SDK has.
     */
    @Test
    public void onlyTheSdkHandlerThreadIsLive() {
        assertEquals(12_345L, ReportHandlerDeadlines.forThread("BugseeReportHandlerThread", 12_345L));
        assertEquals(2_500L, ReportHandlerDeadlines.forThread("main", 12_345L));
        assertEquals(2_500L, ReportHandlerDeadlines.forThread("BugseeRN-x", 12_345L));
    }

    /**
     * The name is the SDK's documented contract (ReportHandler Javadoc) and
     * the value of its own constant. Compared against both: the constant is
     * inlined at compile time, so this pins the SDK version we build against.
     */
    @Test
    public void handlerThreadNameMatchesTheJavadoc() {
        assertEquals("BugseeReportHandlerThread", ReportHandlerDeadlines.LIVE_HANDLER_THREAD);
        assertEquals(BugseeHandlers.REPORT_HANDLER_THREAD_NAME, ReportHandlerDeadlines.LIVE_HANDLER_THREAD);
    }
}
