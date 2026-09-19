package com.bugsee.reactnative;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
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
}
