package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.contracts.reporting.Report;
import com.bugsee.reactnative.ReportHandlerBridge.Phase;

import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The one property everything here protects: the SDK's completion runs
 * exactly once for every dispatch, whichever of JS, the deadline, a detach or
 * a failure gets there first. Running it twice advances the SDK's chain twice;
 * never running it stalls the report until the SDK's own timeout.
 */
public class ReportHandlerBridgeTest {

    /** Runs a task only when the test says so; records cancellation. */
    private static final class ManualScheduler implements ReportHandlerBridge.Scheduler {
        static final class Task implements ReportHandlerBridge.Cancellable {
            final Runnable runnable;
            final long delayMs;
            boolean cancelled;

            Task(final Runnable runnable, final long delayMs) {
                this.runnable = runnable;
                this.delayMs = delayMs;
            }

            @Override
            public void cancel() {
                cancelled = true;
            }
        }

        final List<Task> tasks = new ArrayList<>();

        @Override
        public ReportHandlerBridge.Cancellable schedule(final Runnable task, final long delayMs) {
            final Task t = new Task(task, delayMs);
            tasks.add(t);
            return t;
        }

        void fireDue() {
            for (final Task t : new ArrayList<>(tasks)) {
                if (!t.cancelled) {
                    t.runnable.run();
                }
            }
        }

        /**
         * The real race: the timer thread has already started the task when
         * {@code cancel()} arrives, so cancelling does not stop it.
         */
        void fireEvenIfCancelled() {
            for (final Task t : new ArrayList<>(tasks)) {
                t.runnable.run();
            }
        }
    }

    private static final class Request {
        final String handleId;
        final String phase;
        final String reportId;
        final String type;
        final double deadlineMs;

        Request(final String handleId, final String phase, final String reportId,
                final String type, final double deadlineMs) {
            this.handleId = handleId;
            this.phase = phase;
            this.reportId = reportId;
            this.type = type;
            this.deadlineMs = deadlineMs;
        }
    }

    private static final class Recorder implements ReportHandlerBridge.Sink {
        final List<Request> requests = new ArrayList<>();

        @Override
        public void onReportHandlerRequest(final String handleId, final String phase,
                final String reportId, final String type, final double deadlineMs) {
            requests.add(new Request(handleId, phase, reportId, type, deadlineMs));
        }

        Request last() {
            return requests.get(requests.size() - 1);
        }
    }

    private ManualScheduler scheduler;
    private long liveMs;
    private ReportHandlerBridge bridge;
    private Recorder sink;
    private Report report;
    private AtomicInteger completions;
    private Runnable completion;
    private List<String> lines;

    @Before
    public void setUp() {
        scheduler = new ManualScheduler();
        liveMs = ReportHandlerDeadlines.LIVE_DEADLINE_MS;
        lines = new ArrayList<>();
        bridge = new ReportHandlerBridge(scheduler, () -> liveMs, lines::add);
        sink = new Recorder();
        report = FakeReports.create(new FakeReports.State());
        completions = new AtomicInteger();
        completion = completions::incrementAndGet;
    }

    private void attachWithBothPhases() {
        bridge.attach(sink);
        bridge.setPhases(true, true);
    }

    /**
     * Runs {@code body} on a thread with the given name, rethrowing whatever
     * it throws -- an assertion or an escaped exception on another thread
     * would otherwise pass silently.
     */
    private static void onThread(final String name, final Runnable body) {
        final Throwable[] thrown = new Throwable[1];
        final Thread thread = new Thread(() -> {
            try {
                body.run();
            } catch (final Throwable e) {
                thrown[0] = e;
            }
        }, name);
        thread.start();
        try {
            thread.join();
        } catch (final InterruptedException e) {
            throw new AssertionError(e);
        }
        if (thrown[0] != null) {
            throw new AssertionError("thrown on " + name, thrown[0]);
        }
    }

    /** A dispatch from the SDK's live report-handler thread: the only one that reaches JS. */
    private void dispatchLive(final Phase phase, final Report r, final boolean terminating,
            final Runnable sdkCompletion) {
        onThread(ReportHandlerDeadlines.LIVE_HANDLER_THREAD,
                () -> bridge.dispatch(phase, r, terminating, sdkCompletion));
    }

    /**
     * Early-crash recovery: the SDK runs this on a spawned bounded thread,
     * does not wait for the completion, and proceeds when the handler returns.
     * JS attached then is queued behind its own {@code launch} call, so it
     * could never act in time; a handle would only let a write "succeed"
     * after the report has moved on.
     */
    @Test
    public void aNonLiveThreadCompletesAtOnceAndNeverReachesJs() {
        attachWithBothPhases();

        onThread("bugsee-report-handler-bounded",
                () -> bridge.dispatch(Phase.AFTER, report, false, completion));
        bridge.dispatch(Phase.BEFORE, report, false, completion);

        assertEquals(2, completions.get());
        assertTrue(sink.requests.isEmpty());
        assertTrue(scheduler.tasks.isEmpty());
        assertEquals(2, lines.size());
        assertEquals("report handler - completed by=recovery phase=after report=report-1", lines.get(0));
        assertEquals("report handler - completed by=recovery phase=before report=report-1", lines.get(1));
    }

    /** The same registration on the live thread does reach JS. */
    @Test
    public void theLiveThreadStillReachesJs() {
        attachWithBothPhases();

        dispatchLive(Phase.AFTER, report, false, completion);

        assertEquals(1, sink.requests.size());
        assertEquals(0, completions.get());
        final String id = sink.last().handleId;
        assertEquals("report handler " + id + " phase=after deadline=25000", lines.get(0));

        assertTrue(bridge.complete(id));
        assertEquals("report handler " + id + " completed by=js", lines.get(1));
        assertEquals(1, completions.get());
    }

    /**
     * The process dies after the SDK's callback returns; nothing asynchronous
     * survives it, so JS is never asked.
     */
    @Test
    public void terminatingCompletesSynchronouslyAndNeverReachesJs() {
        attachWithBothPhases();

        dispatchLive(Phase.BEFORE, report, true, completion);

        assertEquals(1, completions.get());
        assertTrue(sink.requests.isEmpty());
        assertTrue(scheduler.tasks.isEmpty());
    }

    /** Start-up, or after a reload tore the bridge down. */
    @Test
    public void noSinkCompletesImmediately() {
        bridge.setPhases(true, true);

        dispatchLive(Phase.AFTER, report, false, completion);

        assertEquals(1, completions.get());
        assertTrue(scheduler.tasks.isEmpty());
    }

    /** JS registered only one phase; the other must not cost a round trip. */
    @Test
    public void unregisteredPhaseCompletesImmediately() {
        bridge.attach(sink);
        bridge.setPhases(false, true);

        dispatchLive(Phase.BEFORE, report, false, completion);

        assertEquals(1, completions.get());
        assertTrue(sink.requests.isEmpty());

        dispatchLive(Phase.AFTER, report, false, completion);
        assertEquals(1, sink.requests.size());
        assertEquals(1, completions.get());
    }

    /** An app that set the SDK cap to 1 s leaves JS no useful time at all. */
    @Test
    public void tooShortADeadlineCompletesWithoutEmitting() {
        attachWithBothPhases();
        liveMs = ReportHandlerDeadlines.liveMs(1);

        dispatchLive(Phase.AFTER, report, false, completion);

        assertEquals(1, completions.get());
        assertTrue(sink.requests.isEmpty());
        assertTrue(scheduler.tasks.isEmpty());
    }

    /** The live thread gets the live deadline, and the timer is armed with it. */
    @Test
    public void theLiveThreadGetsTheLiveDeadline() {
        attachWithBothPhases();
        liveMs = 9_000L;

        dispatchLive(Phase.BEFORE, report, false, completion);

        final Request request = sink.last();
        assertEquals("before", request.phase);
        assertEquals("report-1", request.reportId);
        assertEquals("bug", request.type);
        assertEquals(9_000.0, request.deadlineMs, 0.0);
        assertEquals(9_000L, scheduler.tasks.get(0).delayMs);
    }

    /** {@code onAfter} can be delivered more than once for one report. */
    @Test
    public void eachDeliveryGetsAFreshHandle() {
        attachWithBothPhases();

        dispatchLive(Phase.AFTER, report, false, completion);
        dispatchLive(Phase.AFTER, report, false, completion);

        final String first = sink.requests.get(0).handleId;
        final String second = sink.requests.get(1).handleId;
        assertNotEquals(first, second);
        assertTrue(first.startsWith("rh-"));
        assertSame(report, bridge.reportFor(first));
        assertSame(report, bridge.reportFor(second));

        assertTrue(bridge.complete(first));
        assertNull(bridge.reportFor(first));
        assertSame(report, bridge.reportFor(second));
        assertEquals(1, completions.get());
    }

    /**
     * JS completes twice (the dispatcher's own guarantee is once, but a native
     * no-op is the contract), a detach sweeps outstanding handles, and the
     * deadline task was already running when it was cancelled. One completion.
     */
    @Test
    public void completeRunsTheSdkCompletionExactlyOnce() {
        attachWithBothPhases();
        dispatchLive(Phase.BEFORE, report, false, completion);
        final String id = sink.last().handleId;

        assertTrue(bridge.complete(id));
        assertFalse(bridge.complete(id));
        bridge.detach(sink);
        scheduler.fireEvenIfCancelled();

        assertEquals(1, completions.get());
    }

    @Test
    public void deadlineCompletesAndKillsTheHandle() {
        attachWithBothPhases();
        dispatchLive(Phase.AFTER, report, false, completion);
        final String id = sink.last().handleId;
        assertEquals(ReportHandlerDeadlines.LIVE_DEADLINE_MS, scheduler.tasks.get(0).delayMs);

        scheduler.fireDue();

        assertEquals(1, completions.get());
        assertNull(bridge.reportFor(id));
        assertFalse(bridge.complete(id));
        assertEquals(1, completions.get());
    }

    @Test
    public void completingBeforeTheDeadlineCancelsTheTimer() {
        attachWithBothPhases();
        dispatchLive(Phase.AFTER, report, false, completion);

        bridge.complete(sink.last().handleId);

        assertTrue(scheduler.tasks.get(0).cancelled);
    }

    /** A dead bridge throws from the emit, on the SDK's thread. */
    @Test
    public void aThrowingSinkStillCompletes() {
        bridge.attach((handleId, phase, reportId, type, deadlineMs) -> {
            throw new IllegalStateException("bridge is gone");
        });
        bridge.setPhases(true, true);

        dispatchLive(Phase.BEFORE, report, false, completion);

        assertEquals(1, completions.get());
        assertTrue(scheduler.tasks.get(0).cancelled);
    }

    @Test
    public void aThrowingSdkCompletionDoesNotEscape() {
        attachWithBothPhases();
        dispatchLive(Phase.BEFORE, report, false, () -> {
            throw new IllegalStateException("sdk failure");
        });

        assertTrue(bridge.complete(sink.last().handleId));

        dispatchLive(Phase.BEFORE, report, true, () -> {
            throw new IllegalStateException("sdk failure");
        });
    }

    /**
     * A reload: nothing in the new JS runtime knows the old handles, so they
     * are completed now rather than left for the deadline, and the phases the
     * old runtime asked for no longer describe anyone.
     */
    @Test
    public void detachCompletesEverythingOutstandingAndClearsPhases() {
        attachWithBothPhases();
        dispatchLive(Phase.BEFORE, report, false, completion);
        dispatchLive(Phase.AFTER, report, false, completion);
        final String first = sink.requests.get(0).handleId;

        bridge.detach(sink);

        assertEquals(2, completions.get());
        assertNull(bridge.reportFor(first));
        assertTrue(scheduler.tasks.get(0).cancelled);
        assertTrue(scheduler.tasks.get(1).cancelled);

        // Phases are cleared: a sink attached later gets nothing until its own
        // runtime registers.
        final Recorder next = new Recorder();
        bridge.attach(next);
        dispatchLive(Phase.AFTER, report, false, completion);
        assertTrue(next.requests.isEmpty());
        assertEquals(3, completions.get());
    }

    /**
     * A fast reload attaches the new module before the old one is invalidated.
     * The old detach must not silence the new bridge -- but the handles it was
     * given die with it.
     */
    @Test
    public void detachingAStaleSinkLeavesTheCurrentOne() {
        attachWithBothPhases();
        dispatchLive(Phase.AFTER, report, false, completion);
        final String staleHandle = sink.last().handleId;

        final Recorder current = new Recorder();
        bridge.attach(current);
        bridge.setPhases(true, true);
        dispatchLive(Phase.AFTER, report, false, completion);
        final String currentHandle = current.last().handleId;

        bridge.detach(sink);

        assertEquals(1, completions.get());
        assertNull(bridge.reportFor(staleHandle));
        assertNotNull(bridge.reportFor(currentHandle));

        dispatchLive(Phase.BEFORE, report, false, completion);
        assertEquals(2, current.requests.size());
    }

    /**
     * The dispatch-vs-detach race, interleaved by hand: detach() runs after
     * dispatch() has read the sink but before it has put the handle. The
     * detach's sweep cannot see a handle not yet in the table, so dispatch
     * itself must notice the sink it read has gone, and complete the handle
     * as the detach would have -- not emit it to the dead runtime and leave
     * the report waiting out the whole deadline.
     *
     * <p>{@code liveMs()} is the seam: dispatch calls it after reading the
     * sink and before putting the handle.
     */
    @Test
    public void aDetachBetweenTheSinkReadAndThePutStillCompletesTheHandle() {
        final ReportHandlerBridge[] racing = new ReportHandlerBridge[1];
        racing[0] = new ReportHandlerBridge(scheduler, () -> {
            racing[0].detach(sink);
            return ReportHandlerDeadlines.LIVE_DEADLINE_MS;
        }, lines::add);
        racing[0].attach(sink);
        racing[0].setPhases(true, true);

        onThread(ReportHandlerDeadlines.LIVE_HANDLER_THREAD,
                () -> racing[0].dispatch(Phase.AFTER, report, false, completion));

        assertEquals("the SDK completion must run, and exactly once", 1, completions.get());
        assertTrue("nothing may be emitted to the detached runtime", sink.requests.isEmpty());
        for (final ManualScheduler.Task task : scheduler.tasks) {
            assertTrue("no deadline may be left armed", task.cancelled);
        }
        assertEquals("report handler rh-1 completed by=detach", lines.get(lines.size() - 1));
        assertNull(racing[0].reportFor("rh-1"));

        // Nothing left for a later deadline or JS to complete a second time.
        scheduler.fireEvenIfCancelled();
        assertFalse(racing[0].complete("rh-1"));
        assertEquals(1, completions.get());
    }

    /**
     * A new sink is a new JS runtime, which has registered nothing yet. Until
     * it does, a dispatch must not wait on a listener that does not exist.
     */
    @Test
    public void attachingANewSinkClearsPhases() {
        attachWithBothPhases();

        bridge.attach(new Recorder());
        dispatchLive(Phase.AFTER, report, false, completion);

        assertEquals(1, completions.get());
    }
}
