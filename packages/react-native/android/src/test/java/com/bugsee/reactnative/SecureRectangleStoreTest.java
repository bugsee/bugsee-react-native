package com.bugsee.reactnative;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The SDK PULLS this buffer 2-3 times a second, on a background thread on
 * Android and the main thread on Apple, and decides whether to re-read the
 * rectangles by comparing the version it sees against the one it saw last.
 * That makes two properties load-bearing rather than cosmetic:
 *
 * <ul>
 *   <li>a change MUST move the version, or the SDK keeps redacting the region
 *       the app has already stopped considering secret — the privacy defect;</li>
 *   <li>a non-change must NOT move it, or the SDK re-reads on every frame.</li>
 * </ul>
 */
public class SecureRectangleStoreTest {

    private static final int DISPLAY = 0;

    /** `[version, count]` with no rectangles, not an empty buffer. */
    @Test
    public void publishesAnEmptySetBeforeAnythingIsSecured() {
        final int[] packed = new SecureRectangleStore().snapshot(DISPLAY);
        assertEquals(2, packed.length);
        assertEquals(0, packed[1]);
    }

    @Test
    public void packsVersionCountThenEachRectangle() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.set(DISPLAY, new int[] { 1, 2, 3, 4, 10, 20, 30, 40 });

        final int[] packed = store.snapshot(DISPLAY);
        assertEquals(2, packed[1]);
        assertArrayEquals(
                new int[] { 1, 2, 3, 4, 10, 20, 30, 40 },
                java.util.Arrays.copyOfRange(packed, 2, packed.length));
    }

    @Test
    public void movesTheVersionWhenTheRectanglesChange() {
        final SecureRectangleStore store = new SecureRectangleStore();
        final int before = store.snapshot(DISPLAY)[0];

        store.set(DISPLAY, new int[] { 1, 2, 3, 4 });

        assertNotEquals(before, store.snapshot(DISPLAY)[0]);
    }

    /** Re-publishing the same set must not make the SDK re-read it. */
    @Test
    public void holdsTheVersionWhenNothingChanges() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.set(DISPLAY, new int[] { 1, 2, 3, 4 });
        final int settled = store.snapshot(DISPLAY)[0];

        store.set(DISPLAY, new int[] { 1, 2, 3, 4 });

        assertEquals(settled, store.snapshot(DISPLAY)[0]);
    }

    /**
     * The dangerous case: same COUNT, different coordinates. A version keyed on
     * the number of rectangles rather than their contents would hold here, and
     * the SDK would go on redacting the old region while the new one is exposed.
     */
    @Test
    public void movesTheVersionWhenOnlyTheCoordinatesChange() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.set(DISPLAY, new int[] { 1, 2, 3, 4 });
        final int before = store.snapshot(DISPLAY)[0];

        store.set(DISPLAY, new int[] { 9, 2, 3, 4 });

        assertNotEquals(before, store.snapshot(DISPLAY)[0]);
    }

    /** Clearing is a change like any other: the last secret region must stop. */
    @Test
    public void movesTheVersionWhenTheLastRectangleIsRemoved() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.set(DISPLAY, new int[] { 1, 2, 3, 4 });
        final int before = store.snapshot(DISPLAY)[0];

        store.set(DISPLAY, new int[0]);

        assertNotEquals(before, store.snapshot(DISPLAY)[0]);
        assertEquals(0, store.snapshot(DISPLAY)[1]);
    }

    /** The freshness clock is per display, so one screen cannot stale another. */
    @Test
    public void versionsEachDisplayIndependently() {
        final SecureRectangleStore store = new SecureRectangleStore();
        final int otherBefore = store.snapshot(1)[0];

        store.set(DISPLAY, new int[] { 1, 2, 3, 4 });

        assertEquals(otherBefore, store.snapshot(1)[0]);
        assertEquals(0, store.snapshot(1)[1]);
    }

    /**
     * A fresh array per pull. The header is explicit that a buffer rewritten
     * from another thread while the SDK reads it is a use-after-free, and our
     * writes come from the JS thread while the pull is on a background one.
     */
    @Test
    public void handsOutASnapshotThatCannotAliasTheStore() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.set(DISPLAY, new int[] { 1, 2, 3, 4 });

        final int[] first = store.snapshot(DISPLAY);
        assertNotSame(first, store.snapshot(DISPLAY));

        first[2] = 999;
        assertEquals(1, store.snapshot(DISPLAY)[2]);
    }

    /** Callers cannot keep writing through the array they handed us either. */
    @Test
    public void copiesWhatItIsGiven() {
        final SecureRectangleStore store = new SecureRectangleStore();
        final int[] mutable = { 1, 2, 3, 4 };
        store.set(DISPLAY, mutable);

        mutable[0] = 999;

        assertEquals(1, store.snapshot(DISPLAY)[2]);
    }

    /**
     * Four ints per rectangle. A truncated tail would be packed as a rectangle
     * with garbage coordinates, redacting somewhere arbitrary, so this fails
     * loudly at the boundary instead.
     */
    @Test
    public void rejectsACoordinateListThatIsNotWholeRectangles() {
        final SecureRectangleStore store = new SecureRectangleStore();
        final IllegalArgumentException thrown = assertThrows(
                IllegalArgumentException.class,
                () -> store.set(DISPLAY, new int[] { 1, 2, 3 }));
        assertTrue(thrown.getMessage().contains("4"));
    }

    @Test
    public void rejectsNullCoordinates() {
        assertThrows(IllegalArgumentException.class,
                () -> new SecureRectangleStore().set(DISPLAY, null));
    }

    // ---- Display origin -------------------------------------------------
    //
    // JS publishes measureInWindow values, which React Native makes relative
    // to the root's viewport offset. With edge-to-edge off that offset has
    // the status bar and cutout subtracted, and in split-screen/freeform the
    // window is not at the display's origin either. The SDK wants display
    // pixels, so the store adds the React root's display origin to every
    // rectangle it serves.

    @Test
    public void translatesEveryRectangleByTheDisplayOrigin() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.setOrigin(DISPLAY, 7, 96);
        store.set(DISPLAY, new int[] { 10, 20, 30, 40, 50, 60, 70, 80 });

        final int[] packed = store.snapshot(DISPLAY);
        assertEquals(2, packed[1]);
        assertArrayEquals(
                new int[] { 17, 116, 37, 136, 57, 156, 77, 176 },
                java.util.Arrays.copyOfRange(packed, 2, packed.length));
    }

    /**
     * The origin can arrive, or change (rotation, a window resize), after the
     * rectangles were published: the served set must follow it, and the SDK
     * must be told to re-read.
     */
    @Test
    public void anOriginChangeMovesPublishedRectanglesAndTheVersion() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.set(DISPLAY, new int[] { 10, 20, 30, 40 });
        final int before = store.snapshot(DISPLAY)[0];

        store.setOrigin(DISPLAY, 0, 96);

        final int[] packed = store.snapshot(DISPLAY);
        assertNotEquals(before, packed[0]);
        assertArrayEquals(new int[] { 10, 116, 30, 136 },
                java.util.Arrays.copyOfRange(packed, 2, packed.length));
    }

    /** The origin is re-reported on every layout pass; an unchanged one is free. */
    @Test
    public void anUnchangedOriginHoldsTheVersion() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.setOrigin(DISPLAY, 0, 96);
        store.set(DISPLAY, new int[] { 10, 20, 30, 40 });
        final int settled = store.snapshot(DISPLAY)[0];

        store.setOrigin(DISPLAY, 0, 96);

        assertEquals(settled, store.snapshot(DISPLAY)[0]);
    }

    /** A republish after an origin change keeps the origin, not (0, 0). */
    @Test
    public void keepsTheOriginAcrossRepublishes() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.setOrigin(DISPLAY, 0, 96);
        store.set(DISPLAY, new int[] { 1, 2, 3, 4 });
        store.set(DISPLAY, new int[] { 10, 20, 30, 40 });

        final int[] packed = store.snapshot(DISPLAY);
        assertArrayEquals(new int[] { 10, 116, 30, 136 },
                java.util.Arrays.copyOfRange(packed, 2, packed.length));
    }

    @Test
    public void anOriginAppliesOnlyToItsOwnDisplay() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.setOrigin(1, 0, 96);
        store.set(DISPLAY, new int[] { 10, 20, 30, 40 });

        final int[] packed = store.snapshot(DISPLAY);
        assertArrayEquals(new int[] { 10, 20, 30, 40 },
                java.util.Arrays.copyOfRange(packed, 2, packed.length));
    }

    /** An origin with nothing secured serves the empty set, at the empty version. */
    @Test
    public void anOriginAloneSecuresNothing() {
        final SecureRectangleStore store = new SecureRectangleStore();
        final int[] empty = store.snapshot(DISPLAY);

        store.setOrigin(DISPLAY, 0, 96);

        assertArrayEquals(empty, store.snapshot(DISPLAY));
    }

    /** Past int32 the sum saturates outwards rather than wrapping elsewhere. */
    @Test
    public void saturatesOutwardsInsteadOfWrapping() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.setOrigin(DISPLAY, -10, 10);
        store.set(DISPLAY, new int[] {
                Integer.MIN_VALUE + 5, 0, 0, Integer.MAX_VALUE - 5 });

        final int[] packed = store.snapshot(DISPLAY);
        assertArrayEquals(
                new int[] { Integer.MIN_VALUE, 10, -10, Integer.MAX_VALUE },
                java.util.Arrays.copyOfRange(packed, 2, packed.length));
    }

    @Test
    public void theDisplayOriginIsTheScreenLocationLessTheViewportOffset() {
        // Edge-to-edge off, 96 px status bar: RN's viewport offset is the
        // root's window location less the status-bar inset, i.e. (0, 0),
        // while the root sits at (0, 96) on the display.
        assertArrayEquals(new int[] { 0, 96 },
                SecureRectangleStore.displayOrigin(new int[] { 0, 96 }, 0, 0));
        // Edge-to-edge on: RN's offset already is the screen location.
        assertArrayEquals(new int[] { 0, 0 },
                SecureRectangleStore.displayOrigin(new int[] { 0, 96 }, 0, 96));
        // Any mix: each axis is screen location less viewport offset.
        assertArrayEquals(new int[] { 80, 1200 },
                SecureRectangleStore.displayOrigin(new int[] { 80, 1296 }, 0, 96));
    }

    // ---- The TurboModule's entry point ----------------------------------
    //
    // setSecureRectangles is a void TurboModule method: an exception thrown
    // out of it has no promise to reject and takes the host app down. The
    // module publishes through publishOrLog, which never throws.

    @Test
    public void publishOrLogRejectsABadListWithoutThrowingOrTouchingTheSet() {
        final SecureRectangleStore store = new SecureRectangleStore();
        store.set(DISPLAY, new int[] { 1, 2, 3, 4 });
        final int[] before = store.snapshot(DISPLAY);

        assertFalse(store.publishOrLog(DISPLAY, new int[] { 1, 2, 3 }));
        assertFalse(store.publishOrLog(DISPLAY, null));

        assertArrayEquals(before, store.snapshot(DISPLAY));
    }

    @Test
    public void publishOrLogPublishesAGoodList() {
        final SecureRectangleStore store = new SecureRectangleStore();

        assertTrue(store.publishOrLog(DISPLAY, new int[] { 1, 2, 3, 4 }));

        assertEquals(1, store.snapshot(DISPLAY)[1]);
    }
}
