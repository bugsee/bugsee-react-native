package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.contracts.internal.DataRequestTypes;

import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * The one property everything here protects: the SDK's {@code
 * DataRequestResultCallback} runs exactly once for every {@link
 * DataRequestBridge#request}, whichever of JS, the deadline, or a detach gets
 * there first -- mirroring {@link ReportHandlerBridgeTest}.
 */
public class DataRequestBridgeTest {

    /** Runs a task only when the test says so; records cancellation. */
    private static final class ManualScheduler implements DataRequestBridge.Scheduler {
        static final class Task implements DataRequestBridge.Cancellable {
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
        public DataRequestBridge.Cancellable schedule(final Runnable task, final long delayMs) {
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
        final String requestId;
        final String type;
        final int originX;
        final int originY;

        Request(final String requestId, final String type, final int originX, final int originY) {
            this.requestId = requestId;
            this.type = type;
            this.originX = originX;
            this.originY = originY;
        }
    }

    private static final class Recorder implements DataRequestBridge.Sink {
        final List<Request> requests = new ArrayList<>();

        @Override
        public void onDataRequest(final String requestId, final String type, final int originX, final int originY) {
            requests.add(new Request(requestId, type, originX, originY));
        }

        Request last() {
            return requests.get(requests.size() - 1);
        }
    }

    private static final class FixedOrigin implements DataRequestBridge.OriginSource {
        int[] origin = { 12, 34 };

        @Override
        public int[] currentOrigin() {
            return origin;
        }
    }

    /** Records every reply delivered to it, in order. */
    private static final class Reply {
        final List<String> results = new ArrayList<>();
        int calls;

        void onResult(final String data) {
            calls++;
            results.add(data);
        }
    }

    private ManualScheduler scheduler;
    private long now;
    private DataRequestBridge bridge;
    private Recorder sink;
    private FixedOrigin origin;

    @Before
    public void setUp() {
        scheduler = new ManualScheduler();
        now = 1_000L;
        bridge = new DataRequestBridge(scheduler, () -> now);
        sink = new Recorder();
        origin = new FixedOrigin();
    }

    private void attachAndEnable() {
        bridge.attach(sink, origin);
        bridge.setViewTreeEnabled(true);
    }

    @Test
    public void theTypeMatchesTheSdkConstant() {
        assertEquals(DataRequestTypes.VIEW_HIERARCHY, DataRequestBridge.VIEW_HIERARCHY);
    }

    @Test
    public void theDeadlineIsBelowTheSdkBudget() {
        assertTrue(DataRequestBridge.DEADLINE_MS < DataRequestTypes.VIEW_HIERARCHY_TIMEOUT_MS);
    }

    @Test
    public void anUnknownTypeRepliesNullSynchronously() {
        attachAndEnable();
        final Reply reply = new Reply();

        bridge.request("other", reply::onResult);

        assertEquals(1, reply.calls);
        assertNull(reply.results.get(0));
        assertTrue(sink.requests.isEmpty());
        assertTrue(scheduler.tasks.isEmpty());
    }

    @Test
    public void noSinkRepliesNullSynchronously() {
        final Reply reply = new Reply();

        bridge.request(DataRequestBridge.VIEW_HIERARCHY, reply::onResult);

        assertEquals(1, reply.calls);
        assertNull(reply.results.get(0));
        assertTrue(scheduler.tasks.isEmpty());
    }

    @Test
    public void aDisabledViewTreeRepliesNullSynchronously() {
        // Attached, but nothing has called setViewTreeEnabled(true) yet.
        bridge.attach(sink, origin);
        final Reply reply = new Reply();

        bridge.request(DataRequestBridge.VIEW_HIERARCHY, reply::onResult);

        assertEquals(1, reply.calls);
        assertNull(reply.results.get(0));
        assertTrue(sink.requests.isEmpty());
    }

    @Test
    public void noOriginRepliesNullSynchronously() {
        origin.origin = null;
        attachAndEnable();
        final Reply reply = new Reply();

        bridge.request(DataRequestBridge.VIEW_HIERARCHY, reply::onResult);

        assertEquals(1, reply.calls);
        assertNull(reply.results.get(0));
        assertTrue(sink.requests.isEmpty());
    }

    @Test
    public void theSinkGetsTheOrigin() {
        attachAndEnable();
        origin.origin = new int[] { 55, 66 };

        bridge.request(DataRequestBridge.VIEW_HIERARCHY, data -> { });

        final Request request = sink.last();
        assertEquals(DataRequestBridge.VIEW_HIERARCHY, request.type);
        assertEquals(55, request.originX);
        assertEquals(66, request.originY);
        assertTrue(request.requestId.startsWith("dr-"));
    }

    @Test
    public void completeDeliversThePayloadExactlyOnce() {
        attachAndEnable();
        final Reply reply = new Reply();
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, reply::onResult);
        final String id = sink.last().requestId;

        assertTrue(bridge.complete(id, "{\"a\":1}"));
        // The deadline task captured the entry directly; cancel() cannot stop
        // one that was already running when it raced complete(). Firing it
        // anyway must not re-run the reply -- only the AtomicBoolean guard
        // prevents a second delivery here, since the entry is already gone
        // from the table.
        scheduler.fireEvenIfCancelled();

        assertEquals(1, reply.calls);
        assertEquals("{\"a\":1}", reply.results.get(0));
    }

    @Test
    public void aSecondCompleteIsANoOp() {
        attachAndEnable();
        final Reply reply = new Reply();
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, reply::onResult);
        final String id = sink.last().requestId;

        assertTrue(bridge.complete(id, "first"));
        assertFalse(bridge.complete(id, "second"));

        assertEquals(1, reply.calls);
        assertEquals("first", reply.results.get(0));
    }

    @Test
    public void theDeadlineRepliesNull() {
        attachAndEnable();
        final Reply reply = new Reply();
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, reply::onResult);
        assertEquals(DataRequestBridge.DEADLINE_MS, scheduler.tasks.get(0).delayMs);

        scheduler.fireDue();

        assertEquals(1, reply.calls);
        assertNull(reply.results.get(0));
    }

    @Test
    public void completingCancelsTheDeadline() {
        attachAndEnable();
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, data -> { });

        bridge.complete(sink.last().requestId, "x");

        assertTrue(scheduler.tasks.get(0).cancelled);
    }

    @Test
    public void aThrowingSinkRepliesNull() {
        bridge.attach((requestId, type, originX, originY) -> {
            throw new IllegalStateException("sink is gone");
        }, origin);
        bridge.setViewTreeEnabled(true);
        final Reply reply = new Reply();

        bridge.request(DataRequestBridge.VIEW_HIERARCHY, reply::onResult);

        assertEquals(1, reply.calls);
        assertNull(reply.results.get(0));
        assertTrue(scheduler.tasks.get(0).cancelled);
    }

    @Test
    public void aThrowingReplyDoesNotEscape() {
        attachAndEnable();
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, data -> {
            throw new IllegalStateException("js reply threw");
        });
        final String id = sink.last().requestId;

        // Must not throw, either here or when the request itself replied
        // synchronously through a throwing Reply.
        assertTrue(bridge.complete(id, "x"));
    }

    @Test
    public void aThrowingReplyOnASynchronousOutcomeDoesNotEscape() {
        // No sink attached: the null reply runs synchronously inside
        // request() itself.
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, data -> {
            throw new IllegalStateException("js reply threw");
        });
    }

    @Test
    public void detachRepliesNullToEverythingOutstandingAndDisables() {
        attachAndEnable();
        final Reply first = new Reply();
        final Reply second = new Reply();
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, first::onResult);
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, second::onResult);

        bridge.detach(sink);

        assertEquals(1, first.calls);
        assertNull(first.results.get(0));
        assertEquals(1, second.calls);
        assertNull(second.results.get(0));
        assertTrue(scheduler.tasks.get(0).cancelled);
        assertTrue(scheduler.tasks.get(1).cancelled);

        // Disabled: a freshly attached sink gets nothing until IT enables
        // the view tree again.
        final Recorder next = new Recorder();
        bridge.attach(next, origin);
        final Reply third = new Reply();
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, third::onResult);
        assertEquals(1, third.calls);
        assertNull(third.results.get(0));
        assertTrue(next.requests.isEmpty());
    }

    /**
     * A fast reload attaches the new module before the old one is
     * invalidated. The old detach must not silence the new bridge -- but the
     * requests it was given die with it.
     */
    @Test
    public void detachingAStaleSinkLeavesTheCurrentOne() {
        attachAndEnable();
        final Reply stale = new Reply();
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, stale::onResult);

        final Recorder current = new Recorder();
        bridge.attach(current, origin);
        bridge.setViewTreeEnabled(true);
        final Reply currentReply = new Reply();
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, currentReply::onResult);
        final String currentId = current.last().requestId;

        bridge.detach(sink);

        assertEquals(1, stale.calls);
        assertNull(stale.results.get(0));
        assertEquals(0, currentReply.calls);

        assertTrue(bridge.complete(currentId, "still-alive"));
        assertEquals(1, currentReply.calls);
        assertEquals("still-alive", currentReply.results.get(0));
    }

    @Test
    public void eachRequestGetsAFreshId() {
        attachAndEnable();
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, data -> { });
        bridge.request(DataRequestBridge.VIEW_HIERARCHY, data -> { });

        final String first = sink.requests.get(0).requestId;
        final String second = sink.requests.get(1).requestId;
        assertNotEquals(first, second);
        assertTrue(first.startsWith("dr-"));
        assertTrue(second.startsWith("dr-"));
    }
}
