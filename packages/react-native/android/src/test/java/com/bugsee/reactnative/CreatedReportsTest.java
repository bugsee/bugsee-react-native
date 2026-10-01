package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.contracts.reporting.Report;

import org.junit.Test;

import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * One created report is outstanding at a time, from the moment creation is
 * reserved until the report is taken for upload, discarded as null, or
 * cleared. Handles are {@code cr-<n>}, fresh for the life of the registry.
 */
public class CreatedReportsTest {

    private static Report report() {
        return FakeReports.create(new FakeReports.State());
    }

    /** A reservation, and a fulfilled report, each refuse a second reserve. */
    @Test
    public void oneOutstandingAtATime() {
        final CreatedReports reports = new CreatedReports();

        final int stamp = reports.tryReserve();
        assertTrue(stamp != 0);
        assertFalse(reports.reserve());

        reports.fulfil(stamp, report());
        assertFalse(reports.reserve());
    }

    /** The SDK made none: the slot opens again and no handle is minted. */
    @Test
    public void aNullReportFreesTheSlot() {
        final CreatedReports reports = new CreatedReports();

        final int stamp = reports.tryReserve();
        assertTrue(stamp != 0);
        assertNull(reports.fulfil(stamp, null));
        assertTrue(reports.reserve());
    }

    /** Upload takes the report and leaves the slot free. */
    @Test
    public void takeFreesTheSlot() {
        final CreatedReports reports = new CreatedReports();
        final Report created = report();

        final int stamp = reports.tryReserve();
        assertTrue(stamp != 0);
        final String handle = reports.fulfil(stamp, created);
        assertFalse(reports.reserve());

        assertSame(created, reports.take(handle));
        assertTrue(reports.reserve());
    }

    /**
     * The first report is {@code cr-1}, the next {@code cr-2}. Taking the
     * first does not hand its handle out again.
     */
    @Test
    public void handlesAreFreshAndPrefixed() {
        final CreatedReports reports = new CreatedReports();
        final Report first = report();
        final Report second = report();

        final int firstStamp = reports.tryReserve();
        assertTrue(firstStamp != 0);
        assertEquals("cr-1", reports.fulfil(firstStamp, first));
        assertSame(first, reports.take("cr-1"));

        final int secondStamp = reports.tryReserve();
        assertTrue(secondStamp != 0);
        assertEquals("cr-2", reports.fulfil(secondStamp, second));
        assertNull(reports.get("cr-1"));
        assertSame(second, reports.get("cr-2"));
    }

    /** After take, get and take both miss that handle. */
    @Test
    public void aTakenHandleIsGone() {
        final CreatedReports reports = new CreatedReports();
        final Report created = report();

        final int stamp = reports.tryReserve();
        assertTrue(stamp != 0);
        final String handle = reports.fulfil(stamp, created);
        assertSame(created, reports.take(handle));

        assertNull(reports.get(handle));
        assertNull(reports.take(handle));
    }

    /** A held report and a bare reservation both disappear, and the slot opens. */
    @Test
    public void clearFreesEverything() {
        final CreatedReports reports = new CreatedReports();

        final int stamp = reports.tryReserve();
        assertTrue(stamp != 0);
        final String handle = reports.fulfil(stamp, report());
        reports.clear();
        assertNull(reports.get(handle));
        assertNull(reports.take(handle));
        assertTrue(reports.reserve());

        reports.clear();
        assertTrue(reports.reserve());
    }

    /** Eight threads leave the barrier together; one reservation is admitted. */
    @Test
    public void concurrentReservationsAdmitOne() throws Exception {
        final CreatedReports reports = new CreatedReports();
        final int threads = 8;
        final CyclicBarrier start = new CyclicBarrier(threads);
        final AtomicInteger admitted = new AtomicInteger();
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        final Thread[] workers = new Thread[threads];

        for (int i = 0; i < threads; i++) {
            workers[i] = new Thread(() -> {
                try {
                    start.await(5, TimeUnit.SECONDS);
                    if (reports.reserve()) {
                        admitted.incrementAndGet();
                    }
                } catch (final Throwable t) {
                    failure.compareAndSet(null, t);
                }
            });
            workers[i].start();
        }
        for (final Thread worker : workers) {
            worker.join(5000);
            assertFalse(worker.isAlive());
        }

        assertNull(failure.get());
        assertEquals(1, admitted.get());
    }

    /**
     * {@code clear} ends a reservation without cancelling the SDK listener.
     * That listener's stamp must not store its report into, or free, the
     * reservation a later runtime has already opened. A null fulfil with the
     * same stale stamp (the listener's failure path) must not either.
     */
    @Test
    public void aStaleStampDoesNotConsumeANewerReservation() {
        final CreatedReports reports = new CreatedReports();
        final int stale = reports.tryReserve();
        assertTrue(stale != 0);
        reports.clear();

        final int live = reports.tryReserve();
        assertTrue(live != 0);
        assertTrue(live != stale);

        final Report abandoned = report();
        final Report created = report();
        assertNull(reports.fulfil(stale, abandoned));
        assertNull(reports.fulfil(stale, null));
        assertFalse(reports.reserve());

        assertEquals("cr-1", reports.fulfil(live, created));
        assertSame(created, reports.get("cr-1"));
        assertFalse(reports.reserve());
    }
}
