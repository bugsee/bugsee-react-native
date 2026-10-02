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
    public void aFinishedSpanIsReleased() {
        final SpanHandles handles = new SpanHandles();
        final Fake span = new Fake();
        final String handle = handles.retain(span, span);
        final List<String> released = handles.finish(handle, null);
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
        final List<String> released = handles.finish(parentHandle, null);
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
    private static final class Fake implements SpanHandles.Retained {
        boolean finished;
        SpanStatus finishedWith;
        final List<Fake> children = new ArrayList<>();

        @Override
        public void finish(final SpanStatus status) {
            if (finished) {
                return;
            }
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
    }
}
