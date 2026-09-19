package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The regions the app has asked Bugsee not to record, in the form the SDK
 * pulls them.
 *
 * <p>The SDK does not subscribe to changes; it asks, 2-3 times a second, for
 * a packed buffer {@code [version, count, l, t, r, b, ...]} and re-reads the
 * rectangles only when the version differs from the one it last saw. Two
 * properties follow, and both are load-bearing:
 *
 * <ul>
 *   <li>any change to the set MUST move the version. A stale version is a
 *       privacy defect in the dangerous direction: the SDK goes on redacting
 *       the region the app has stopped considering secret, and — worse —
 *       stops redacting nothing, so a newly secret region is recorded in the
 *       clear until something else happens to move the version.</li>
 *   <li>a no-op write must NOT move it, or the SDK re-reads on every frame.</li>
 * </ul>
 *
 * <p>The version is kept per display because the SDK's freshness comparison is
 * per display: a change on one screen must not invalidate another's.
 *
 * <h2>Threading</h2>
 *
 * <p>Writes arrive on the JS thread; the pull happens on a Bugsee background
 * thread (on Apple, the main thread). Every published value is therefore an
 * immutable snapshot, swapped in whole. The SDK's own header is explicit that
 * a buffer rewritten by another thread while it reads is a use-after-free, so
 * nothing here ever hands out, or retains, an array a caller can still write
 * through.
 */
final class SecureRectangleStore {

    /** Four coordinates per rectangle: left, top, right, bottom. */
    private static final int COORDINATES_PER_RECTANGLE = 4;

    /** Precedes the rectangles in every buffer: the version and the count. */
    private static final int HEADER_INTS = 2;

    /**
     * The version a display reports before anything is secured. Any value
     * works as long as it is stable; the SDK only ever compares it against
     * what it saw last.
     */
    private static final int INITIAL_VERSION = 1;

    /** One immutable published set. Replaced wholesale, never edited. */
    private static final class Snapshot {
        final int version;
        final int[] coordinates;

        Snapshot(final int version, @NonNull final int[] coordinates) {
            this.version = version;
            this.coordinates = coordinates;
        }
    }

    /**
     * The process-wide set of secured regions.
     *
     * <p>Deliberately not owned by a wrapper instance. The wrapper object is
     * replaced mid-session — the init provider registers one before launch and
     * setWrapperInfo swaps in the fully-populated one once the bridge is up —
     * and the regions an app has marked secret must not be forgotten when that
     * happens. Losing them would leave the app recorded unredacted until it
     * next happened to re-publish, which is the failure that matters most here.
     */
    private static final SecureRectangleStore SHARED = new SecureRectangleStore();

    @NonNull
    static SecureRectangleStore shared() {
        return SHARED;
    }

    private final Map<Integer, Snapshot> byDisplay = new ConcurrentHashMap<>();

    /**
     * Publishes {@code coordinates} as the secure set for {@code display}, as a
     * flat list of four-int rectangles.
     *
     * <p>The version moves only when the set actually differs, so an app that
     * re-publishes an unchanged layout on every render costs the SDK nothing.
     */
    void set(final int display, @Nullable final int[] coordinates) {
        if (coordinates == null) {
            throw new IllegalArgumentException(
                    "secure rectangles cannot be null; pass an empty array to clear them");
        }
        if (coordinates.length % COORDINATES_PER_RECTANGLE != 0) {
            throw new IllegalArgumentException(
                    "secure rectangles need 4 coordinates each (left, top, right, bottom), got "
                            + coordinates.length);
        }

        // Copy on the way in as well as out: the caller keeps its array and a
        // later write through it would edit a snapshot the SDK is reading.
        final int[] published = coordinates.clone();

        // compute() rather than get-then-put: two JS-thread writes racing on
        // one display would otherwise both read the old version and publish
        // the same new one, so the second change would be invisible to the SDK.
        byDisplay.compute(display, (key, previous) -> {
            if (previous == null) {
                return new Snapshot(nextVersion(INITIAL_VERSION), published);
            }
            if (Arrays.equals(previous.coordinates, published)) {
                return previous;
            }
            return new Snapshot(nextVersion(previous.version), published);
        });
    }

    /**
     * The buffer for {@code display}: {@code [version, count, l, t, r, b, ...]}.
     * A display nothing has secured reports an empty set rather than nothing at
     * all, so the SDK always has a version to compare against.
     */
    @NonNull
    int[] snapshot(final int display) {
        final Snapshot current = byDisplay.get(display);
        if (current == null) {
            return new int[] { INITIAL_VERSION, 0 };
        }

        final int[] packed = new int[HEADER_INTS + current.coordinates.length];
        packed[0] = current.version;
        packed[1] = current.coordinates.length / COORDINATES_PER_RECTANGLE;
        System.arraycopy(current.coordinates, 0, packed, HEADER_INTS,
                current.coordinates.length);
        return packed;
    }

    /**
     * Steps the version, skipping the value that means "nothing secured yet".
     * Wrapping matters only in theory — it takes 2^31 changes — but landing
     * back on the initial version would make a real set look identical to the
     * empty one to an SDK that had only ever seen the latter.
     */
    private static int nextVersion(final int current) {
        final int next = current + 1;
        return next == INITIAL_VERSION ? INITIAL_VERSION + 1 : next;
    }
}
