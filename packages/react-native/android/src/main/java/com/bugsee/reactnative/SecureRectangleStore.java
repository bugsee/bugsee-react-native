package com.bugsee.reactnative;

import android.util.Log;

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

    private static final String TAG = "BugseeRN";

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

    private static final int[] NO_COORDINATES = new int[0];

    /** One immutable published set. Replaced wholesale, never edited. */
    private static final class Snapshot {
        final int version;
        /** As JS published them: relative to React Native's viewport offset. */
        final int[] raw;
        final int originX;
        final int originY;
        /** {@link #raw} moved to the display origin: what the SDK is served. */
        final int[] coordinates;

        Snapshot(final int version, @NonNull final int[] raw,
                final int originX, final int originY) {
            this(version, raw, originX, originY, translate(raw, originX, originY));
        }

        private Snapshot(final int version, @NonNull final int[] raw,
                final int originX, final int originY, @NonNull final int[] coordinates) {
            this.version = version;
            this.raw = raw;
            this.originX = originX;
            this.originY = originY;
            this.coordinates = coordinates;
        }

        @NonNull
        Snapshot withVersion(final int newVersion) {
            return new Snapshot(newVersion, raw, originX, originY, coordinates);
        }
    }

    /** What a display serves before anything is secured or located. */
    private static final Snapshot EMPTY = new Snapshot(INITIAL_VERSION, NO_COORDINATES, 0, 0);

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
        final int[] raw = coordinates.clone();
        update(display, previous -> new Snapshot(0, raw, previous.originX, previous.originY));
    }

    /**
     * {@link #set}, for the TurboModule: a malformed list is logged and
     * dropped instead of thrown. {@code setSecureRectangles} is a void method,
     * so an exception out of it has no promise to reject and would take the
     * host app down; the previous set stays published.
     *
     * @return whether {@code coordinates} was published
     */
    boolean publishOrLog(final int display, @Nullable final int[] coordinates) {
        try {
            set(display, coordinates);
            return true;
        } catch (IllegalArgumentException e) {
            Log.e(TAG, "setSecureRectangles rejected; the previous set stays published: "
                    + e.getClass().getName());
            return false;
        }
    }

    /**
     * Records where the React root's viewport origin sits on {@code display},
     * in display pixels, and serves every rectangle moved by it.
     *
     * <p>JS measures with {@code measureInWindow}, which React Native makes
     * relative to the root's viewport offset
     * ({@code RootViewUtil.getViewportOffset}): the root's location in its
     * window, less the status-bar and cutout insets when edge-to-edge is off.
     * The SDK wants display-relative pixels. Unconverted, every rectangle
     * lands that many pixels up and left of the view it covers, and a strip of
     * each secure region is recorded in the clear.
     *
     * <p>The origin is an integer, so adding it after JS has rounded each edge
     * outwards (floor left/top, ceil right/bottom, after scaling) is exactly
     * the same as rounding after the offset: {@code floor(x) + k == floor(x + k)}
     * for integer {@code k}.
     */
    void setOrigin(final int display, final int originX, final int originY) {
        update(display, previous -> new Snapshot(0, previous.raw, originX, originY));
    }

    /**
     * {@code locationOnScreen} of the React root less React Native's viewport
     * offset for it: the display-pixel position of the origin
     * {@code measureInWindow} measures from.
     */
    @NonNull
    static int[] displayOrigin(@NonNull final int[] locationOnScreen,
            final int viewportX, final int viewportY) {
        return new int[] { locationOnScreen[0] - viewportX, locationOnScreen[1] - viewportY };
    }

    private interface Change {
        /** The next state, built from the current one; its version is ignored. */
        @NonNull
        Snapshot apply(@NonNull Snapshot previous);
    }

    /**
     * The version moves only when the SERVED set differs, so an app that
     * re-publishes an unchanged layout, or a layout pass that re-reports the
     * same origin, costs the SDK nothing.
     *
     * <p>compute() rather than get-then-put: two writes racing on one display
     * (JS thread, UI thread) would otherwise both read the old version and
     * publish the same new one, so the second change would be invisible to
     * the SDK.
     */
    private void update(final int display, @NonNull final Change change) {
        byDisplay.compute(display, (key, current) -> {
            final Snapshot previous = current == null ? EMPTY : current;
            final Snapshot next = change.apply(previous);
            final int version = Arrays.equals(previous.coordinates, next.coordinates)
                    ? previous.version
                    : nextVersion(previous.version);
            return next.withVersion(version);
        });
    }

    /** Every rectangle moved by the origin, saturating rather than wrapping. */
    @NonNull
    private static int[] translate(@NonNull final int[] raw, final int dx, final int dy) {
        final int[] moved = new int[raw.length];
        for (int i = 0; i < raw.length; i++) {
            moved[i] = saturatedAdd(raw[i], i % 2 == 0 ? dx : dy);
        }
        return moved;
    }

    private static int saturatedAdd(final int a, final int b) {
        final long sum = (long) a + b;
        if (sum > Integer.MAX_VALUE) return Integer.MAX_VALUE;
        if (sum < Integer.MIN_VALUE) return Integer.MIN_VALUE;
        return (int) sum;
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
