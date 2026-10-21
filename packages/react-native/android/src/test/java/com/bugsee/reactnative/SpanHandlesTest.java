package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.contracts.performance.SpanStatus;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * A finished span must leave the registry. These fail if {@code finish}
 * keeps the native object: {@code contains} would still be true and
 * {@code size} would not drop to zero.
 */
public class SpanHandlesTest {

    @Test
    public void cancelOpenAndReleaseAllCancelsOwnedOpenSpansParentFirstAndOnce() {
        final SpanHandles handles = new SpanHandles();
        final List<Fake> order = new ArrayList<>();
        final Fake parent = new Fake(order);
        final Fake child = new Fake(order);
        final Fake done = new Fake(order);
        done.finished = true;
        parent.children.add(child);
        handles.retain(parent, parent);
        handles.retain(child, child);
        handles.retain(done, done);
        handles.cancelOpenAndReleaseAll();
        assertEquals(1, parent.finishCalls);
        assertEquals(SpanStatus.CANCELLED, parent.finishedWith);
        assertEquals(1, child.finishCalls);
        assertEquals(SpanStatus.CANCELLED, child.finishedWith);
        assertEquals(0, done.finishCalls);
        assertEquals(Arrays.asList(parent, child), order);
        assertEquals(0, handles.size());
    }

    @Test
    public void cancelOpenAndReleaseAllDropsAdoptedSpansWithoutCancellingThem() {
        final SpanHandles handles = new SpanHandles();
        final Fake adopted = new Fake();
        final Fake owned = new Fake();
        handles.retain(adopted, adopted, false);
        handles.retain(owned, owned, true);
        handles.cancelOpenAndReleaseAll();
        assertEquals(0, adopted.finishCalls);
        assertFalse(adopted.finished);
        assertEquals(1, owned.finishCalls);
        assertEquals(0, handles.size());
    }

    @Test
    public void aClosedRegistryRetainsNothing() {
        final SpanHandles handles = new SpanHandles();
        handles.cancelOpenAndReleaseAll();
        final Fake late = new Fake();
        assertEquals("", handles.retain(late, late));
        assertEquals(0, handles.size());
    }

    @Test
    public void aSpanThatThrowsDoesNotStopTheRest() {
        final SpanHandles handles = new SpanHandles();
        final Sticky bad = new Sticky() {
            @Override
            public void finish(final SpanStatus status) {
                throw new IllegalStateException("boom");
            }
        };
        final Fake next = new Fake();
        handles.retain(bad, bad);
        handles.retain(next, next);
        handles.cancelOpenAndReleaseAll();
        assertEquals(1, next.finishCalls);
        assertEquals(0, handles.size());
    }

    @Test
    public void finishReportsTheStatusTheSpanHoldsAfterward() {
        final SpanHandles handles = new SpanHandles();
        final Fake parent = new Fake();
        final Fake child = new Fake();
        parent.children.add(child);
        final String p = handles.retain(parent, parent);
        handles.retain(child, child);
        final List<SpanHandles.Released> released = handles.finish(p, SpanStatus.ERROR);
        assertEquals(SpanStatus.ERROR.ordinal(), released.get(0).status);
        assertEquals(SpanStatus.CANCELLED.ordinal(), released.get(1).status);
    }

    @Test
    public void aFinishedSpanIsReleased() {
        final SpanHandles handles = new SpanHandles();
        final Fake span = new Fake();
        final String handle = handles.retain(span, span);
        final List<String> released = handles(handles.finish(handle, null));
        assertEquals(Arrays.asList(handle), released);
        assertTrue(span.finished);
        assertNull(span.finishedWith);
        assertFalse(handles.contains(handle));
        assertEquals(0, handles.size());
    }

    @Test
    public void finishingAParentReleasesAFinishedChild() {
        final SpanHandles handles = new SpanHandles();
        final Fake parent = new Fake();
        final Fake child = new Fake();
        parent.children.add(child);
        final String parentHandle = handles.retain(parent, parent);
        final String childHandle = handles.retain(child, child);
        final List<String> released = handles(handles.finish(parentHandle, null));
        assertTrue(released.contains(parentHandle));
        assertTrue(released.contains(childHandle));
        assertTrue(child.finished);
        assertEquals(SpanStatus.CANCELLED, child.finishedWith);
        assertFalse(handles.contains(childHandle));
        assertEquals(0, handles.size());
    }

    @Test
    public void anUnfinishedSpanStaysRetained() {
        final SpanHandles handles = new SpanHandles();
        final Fake finished = new Fake();
        final Fake live = new Fake();
        final String finishedHandle = handles.retain(finished, finished);
        final String liveHandle = handles.retain(live, live);
        handles.finish(finishedHandle, SpanStatus.ERROR);
        assertFalse(handles.contains(finishedHandle));
        assertTrue(handles.contains(liveHandle));
        assertEquals(1, handles.size());
        assertEquals(SpanStatus.ERROR, finished.finishedWith);
    }

    @Test
    public void theSameSpanIsOneHandle() {
        final SpanHandles handles = new SpanHandles();
        final Fake span = new Fake();
        final String first = handles.retain(span, span);
        final String second = handles.retain(span, new Fake());
        assertEquals(first, second);
        assertEquals(1, handles.size());
    }

    @Test
    public void aSpanThatStaysUnfinishedIsStillReleased() {
        final SpanHandles handles = new SpanHandles();
        final Sticky span = new Sticky();
        final String handle = handles.retain(span, span);
        final List<String> released = handles(handles.finish(handle, null));
        assertEquals(Arrays.asList(handle), released);
        assertTrue(span.finishCalled);
        assertFalse(span.isFinished());
        assertFalse(handles.contains(handle));
        assertEquals(0, handles.size());
    }

    @Test
    public void aNullSpanIsNotRetained() {
        final SpanHandles handles = new SpanHandles();
        assertEquals("", handles.retain(null, new Fake()));
        assertEquals(0, handles.size());
    }

    @Test
    public void anUnknownHandleReleasesNothing() {
        final SpanHandles handles = new SpanHandles();
        assertTrue(handles.finish("sp-nope", null).isEmpty());
        assertEquals(0, handles.size());
    }

    @Test
    public void spanStatusWireIsTheOrdinal() {
        assertEquals(SpanStatus.OK, SpanHandles.status(0));
        assertEquals(SpanStatus.ERROR, SpanHandles.status(1));
        assertEquals(SpanStatus.TIMEOUT, SpanHandles.status(2));
        assertEquals(SpanStatus.CANCELLED, SpanHandles.status(3));
        assertEquals(SpanStatus.DEADLINE_EXCEEDED, SpanHandles.status(4));
        assertEquals(SpanStatus.UNKNOWN, SpanHandles.status(5));
        assertNull(SpanHandles.status(-1));
        assertNull(SpanHandles.status(6));
        assertEquals(0, SpanStatus.OK.ordinal());
        assertEquals(5, SpanStatus.UNKNOWN.ordinal());
    }

    /** A stand-in for the SDK span. Finishing a parent cancels its children. */
    private static List<String> handles(final List<SpanHandles.Released> released) {
        final List<String> out = new ArrayList<>();
        for (final SpanHandles.Released item : released) {
            out.add(item.handle);
        }
        return out;
    }

    /**
     * Records every finish call and does not guard against a second one, so
     * a registry that finishes a span twice shows in {@code finishCalls}.
     * Finishing cascades Cancelled to children, like the SDK.
     */
    private static final class Fake implements SpanHandles.Retained {
        boolean finished;
        int finishCalls;
        SpanStatus finishedWith;
        final List<Fake> children = new ArrayList<>();
        final List<Fake> order;

        Fake() {
            this(new ArrayList<Fake>());
        }

        Fake(final List<Fake> order) {
            this.order = order;
        }

        @Override
        public void finish(final SpanStatus status) {
            finishCalls += 1;
            order.add(this);
            finished = true;
            finishedWith = status;
            for (final Fake child : children) {
                if (!child.finished) {
                    child.finish(SpanStatus.CANCELLED);
                }
            }
        }

        @Override
        public boolean isFinished() {
            return finished;
        }

        @Override
        public int statusOrdinal() {
            return finishedWith == null ? SpanStatus.OK.ordinal() : finishedWith.ordinal();
        }
    }

    /** {@code finish} runs, and {@code isFinished} stays false. A no-op span can do that. */
    private static class Sticky implements SpanHandles.Retained {
        boolean finishCalled;

        @Override
        public void finish(final SpanStatus status) {
            finishCalled = true;
        }

        @Override
        public boolean isFinished() {
            return false;
        }

        @Override
        public int statusOrdinal() {
            return SpanStatus.UNKNOWN.ordinal();
        }
    }
}
