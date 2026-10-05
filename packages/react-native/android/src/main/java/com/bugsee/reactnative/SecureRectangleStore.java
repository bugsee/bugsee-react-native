package com.bugsee.reactnative;

import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.Arrays;
import java.util.Map;
import java.util.TreeMap;
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
 * <h2>Surfaces</h2>
 *
 * <p>JS measures with {@code measureInWindow}, which Fabric makes relative to
 * the measured node's nearest {@code RootNodeKind} ancestor
 * ({@code LayoutableShadowNode.cpp} stops the ancestor walk there;
 * {@code ModalHostViewShadowNode} sets that trait). The activity React root
 * and a {@code <Modal>}'s {@code DialogRootViewGroup} are different surfaces:
 * each rectangle is stored under the surface it was measured in, and served
 * translated by <em>that</em> surface's display origin (see {@link
 * ReactRootOriginTracker#surfaceOrigin}). A single origin for the whole
 * display cannot serve both.
 *
 * <p>Fails closed. A surface whose origin has not been read yet, or whose
 * root was forgotten ({@link #forgetOrigin}), serves its rectangles as one
 * rectangle covering the whole display: an unknown origin must not place a
 * secure region anywhere it could miss. That includes the main surface, so
 * the very first publish masks the whole display until the tracker's first
 * read, a fraction of a second. While no React root can be found at all,
 * the main surface's rectangles stay one whole-display rectangle: there is
 * no origin to read, and the store will not guess one (ruled, N8).
 *
 * <p>A {@code <Modal>} surface belongs to one JS runtime: its key is a React
 * tag that the next runtime does not know. A reload drops every surface but
 * the main one ({@link #claimRuntime}, {@link #releaseRuntime}), so a Modal
 * that was open when the old runtime went away does not mask the display
 * for the rest of the process. A claim also empties the main surface's
 * rectangles, keeping its origin: they were the old runtime's, and its
 * clearing write is ignored once stale (below), so without this a new tree
 * that never publishes on the main surface would leave them masking until
 * the process dies. The new runtime's first publish is then the only main
 * set.
 *
 * <p>The claim also gates every lane write a runtime makes: the module's
 * publish ({@link #publishForRuntime}) and its tracker's origin writes
 * ({@link #setOriginForRuntime}, {@link #forgetOriginForRuntime}, {@link
 * #dropSurfaceIfEmptyForRuntime}). A write whose claim is no longer current
 * is ignored, under the same lock as the claim. A reload can construct the
 * new module before the old one is invalidated, and Fabric numbers React
 * tags from 1 again, so the old runtime's late writes would otherwise put
 * back a lane the claim dropped or clear the new runtime's lane on the same
 * key, uncovering its Modal. The display size is not a runtime's state: it
 * is recorded by whoever reads it.
 *
 * <p>Every served rectangle is clamped to the display's real size once it
 * is known ({@link #setDisplayBounds}). The SDK's native video mask clamps a
 * rectangle's rows to the frame but not its right edge to a row, so a
 * rectangle wider than the frame would black out the start of the next row
 * on every row: it must never be handed one.
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

    /**
     * The activity React root's surface key. Legacy {@link #set}/{@link
     * #setOrigin} writers that do not name a surface land here; a {@code
     * <Modal>}'s {@code DialogRootViewGroup} uses a different key.
     */
    static final int MAIN_SURFACE = 0;

    /**
     * The bounds a display serves a fail-closed lane as when its real size
     * has not been recorded ({@link #setDisplayBounds}): bigger than any
     * phone or tablet panel, and small enough that a renderer that does not
     * clip a rectangle's right edge per row still stays cheap.
     */
    static final int FALLBACK_DISPLAY_SIZE = 16384;

    /** One surface's raw measurements and the origin that places them. */
    private static final class Lane {
        /** As JS published them: relative to this surface's own origin. */
        final int[] raw;
        final int originX;
        final int originY;
        /** Whether {@link #originX}/{@link #originY} were read (and still hold). */
        final boolean originKnown;

        Lane(@NonNull final int[] raw, final int originX, final int originY, final boolean originKnown) {
            this.raw = raw;
            this.originX = originX;
            this.originY = originY;
            this.originKnown = originKnown;
        }

        @NonNull
        Lane withRaw(@NonNull final int[] newRaw) {
            return new Lane(newRaw, originX, originY, originKnown);
        }

        @NonNull
        Lane withOrigin(final int newOriginX, final int newOriginY) {
            return new Lane(raw, newOriginX, newOriginY, true);
        }

        @NonNull
        Lane withOriginUnknown() {
            return new Lane(raw, originX, originY, false);
        }
    }

    /** One immutable published set for a display. Replaced wholesale. */
    private static final class Snapshot {
        final int version;
        /** Surface key → lane. TreeMap so the served order is stable. */
        final TreeMap<Integer, Lane> lanes;
        /** The display's real size {@code {width, height}} in pixels, or {@code null}. */
        @Nullable
        final int[] bounds;
        /** What the SDK is served: every lane in surface-key order, clamped to {@link #bounds}. */
        final int[] coordinates;

        Snapshot(final int version, @NonNull final TreeMap<Integer, Lane> lanes, @Nullable final int[] bounds) {
            this.version = version;
            // Defensive copies: callers must not retain a mutable reference.
            this.lanes = new TreeMap<>(lanes);
            this.bounds = bounds == null ? null : bounds.clone();
            this.coordinates = serve(this.lanes, this.bounds);
        }

        @NonNull
        Snapshot withVersion(final int newVersion) {
            return new Snapshot(newVersion, lanes, bounds);
        }

        @NonNull
        Snapshot withLanes(@NonNull final TreeMap<Integer, Lane> nextLanes) {
            return new Snapshot(0, nextLanes, bounds);
        }

        @NonNull
        Snapshot withBounds(@NonNull final int[] nextBounds) {
            return new Snapshot(0, lanes, nextBounds);
        }

        /**
         * A lane whose origin is unknown serves the whole display; any other
         * serves its rectangles moved by its origin. Every rectangle is then
         * clamped to the display, and one left with no area is dropped: a
         * renderer is never handed a rectangle that runs off the panel.
         */
        @NonNull
        private static int[] serve(@NonNull final TreeMap<Integer, Lane> lanes, @Nullable final int[] bounds) {
            final int width = bounds == null ? FALLBACK_DISPLAY_SIZE : bounds[0];
            final int height = bounds == null ? FALLBACK_DISPLAY_SIZE : bounds[1];
            int total = 0;
            for (final Lane lane : lanes.values()) {
                total += lane.raw.length == 0 ? 0 : lane.originKnown ? lane.raw.length : COORDINATES_PER_RECTANGLE;
            }
            if (total == 0) {
                return NO_COORDINATES;
            }
            final int[] served = new int[total];
            int at = 0;
            for (final Lane lane : lanes.values()) {
                if (lane.raw.length == 0) {
                    continue;
                }
                if (!lane.originKnown) {
                    served[at++] = 0;
                    served[at++] = 0;
                    served[at++] = width;
                    served[at++] = height;
                    continue;
                }
                final int[] moved = translate(lane.raw, lane.originX, lane.originY);
                for (int i = 0; i < moved.length; i += COORDINATES_PER_RECTANGLE) {
                    if (bounds == null) {
                        System.arraycopy(moved, i, served, at, COORDINATES_PER_RECTANGLE);
                        at += COORDINATES_PER_RECTANGLE;
                        continue;
                    }
                    final int left = clamp(moved[i], width);
                    final int top = clamp(moved[i + 1], height);
                    final int right = clamp(moved[i + 2], width);
                    final int bottom = clamp(moved[i + 3], height);
                    if (right <= left || bottom <= top) {
                        continue;
                    }
                    served[at++] = left;
                    served[at++] = top;
                    served[at++] = right;
                    served[at++] = bottom;
                }
            }
            return at == served.length ? served : Arrays.copyOf(served, at);
        }

        private static int clamp(final int value, final int max) {
            return Math.max(0, Math.min(value, max));
        }
    }

    /** What a display serves before anything is secured or located. */
    private static final Snapshot EMPTY = new Snapshot(INITIAL_VERSION, new TreeMap<>(), null);

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
     * Publishes {@code coordinates} as the secure set for {@code display}'s
     * main surface, as a flat list of four-int rectangles. Other surfaces on
     * the same display are left alone.
     *
     * <p>The version moves only when the served set actually differs, so an
     * app that re-publishes an unchanged layout on every render costs the SDK
     * nothing.
     */
    void set(final int display, @Nullable final int[] coordinates) {
        set(display, MAIN_SURFACE, coordinates);
    }

    /**
     * Publishes {@code coordinates} for one surface on {@code display}. Other
     * surfaces keep their rectangles and origins.
     */
    void set(final int display, final int surface, @Nullable final int[] coordinates) {
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
        update(display, previous -> withLane(previous, surface, lane -> lane.withRaw(raw)));
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
        return publishOrLog(display, MAIN_SURFACE, coordinates);
    }

    boolean publishOrLog(final int display, final int surface, @Nullable final int[] coordinates) {
        return publishForRuntime(currentClaim(), display, surface, coordinates);
    }

    /**
     * {@link #publishOrLog}, written by the module holding {@code claim}: ignored
     * when a newer runtime has claimed the store since. What the TurboModule
     * calls.
     *
     * @return whether {@code coordinates} was published
     */
    synchronized boolean publishForRuntime(final int claim, final int display, final int surface,
            @Nullable final int[] coordinates) {
        if (!isCurrentLocked(claim)) {
            return false;
        }
        try {
            set(display, surface, coordinates);
            return true;
        } catch (IllegalArgumentException e) {
            Log.e(TAG, "setSecureRectangles rejected; the previous set stays published: "
                    + e.getClass().getName());
            return false;
        }
    }

    /**
     * Records where the main React root's viewport origin sits on {@code
     * display}, in display pixels, and serves that surface's rectangles moved
     * by it. Other surfaces keep their own origins.
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
        setOrigin(display, MAIN_SURFACE, originX, originY);
    }

    /**
     * Records where one surface's viewport origin sits on {@code display}.
     * Only that surface's rectangles move; a {@code <Modal>} and the activity
     * root must not share one origin.
     */
    void setOrigin(final int display, final int surface, final int originX, final int originY) {
        update(display, previous -> withLane(previous, surface,
                lane -> lane.withOrigin(originX, originY)));
    }

    /**
     * {@link #setOrigin(int, int, int, int)}, written by the module holding
     * {@code claim}: ignored when a newer runtime has claimed the store since.
     * An old runtime's dialog root must not place the new runtime's Modal.
     */
    synchronized void setOriginForRuntime(final int claim, final int display, final int surface,
            final int originX, final int originY) {
        if (isCurrentLocked(claim)) {
            setOrigin(display, surface, originX, originY);
        }
    }

    /**
     * Records {@code display}'s real size in pixels: what a fail-closed lane
     * serves, and what every rectangle is clamped to.
     */
    void setDisplayBounds(final int display, final int width, final int height) {
        if (width <= 0 || height <= 0) {
            return;
        }
        update(display, previous -> previous.bounds != null
                && previous.bounds[0] == width && previous.bounds[1] == height
                ? previous
                : previous.withBounds(new int[] { width, height }));
    }

    /** The current JS runtime's claim; see {@link #claimRuntime}. Guarded by {@code this}. */
    private int runtime;

    /**
     * The claim a runtime holds now. For writers that belong to no runtime
     * of their own (tests, single-runtime callers); a module writes with the
     * claim {@link #claimRuntime} gave it.
     */
    synchronized int currentClaim() {
        return runtime;
    }

    /**
     * Whether {@code claim} is still the current runtime's. A stale one is
     * logged at debug, numbers only. Caller holds {@code this}.
     */
    private boolean isCurrentLocked(final int claim) {
        if (claim == runtime) {
            return true;
        }
        if (Log.isLoggable(TAG, Log.DEBUG)) {
            Log.d(TAG, "secure write ignored: runtime claim " + claim
                    + " is stale, current " + runtime);
        }
        return false;
    }

    /**
     * A new JS runtime's module is starting: drops every surface but the main
     * one, whose keys the new runtime cannot know, empties the main one's
     * rectangles (keeping its origin), and returns its claim. Synchronised
     * with {@link #releaseRuntime} so an old module released after the new
     * one started cannot drop the new runtime's surfaces.
     */
    synchronized int claimRuntime() {
        runtime++;
        dropNonMainSurfaces();
        emptyMainSurface();
        return runtime;
    }

    /**
     * Empties the main surface's rectangles on every display, keeping its
     * origin: the old runtime's set must not outlive it, and a new runtime
     * that never publishes on the main surface would otherwise inherit it.
     */
    private void emptyMainSurface() {
        for (final Integer display : byDisplay.keySet()) {
            update(display, previous -> {
                final Lane main = previous.lanes.get(MAIN_SURFACE);
                if (main == null || main.raw.length == 0) {
                    return previous;
                }
                final TreeMap<Integer, Lane> nextLanes = new TreeMap<>(previous.lanes);
                nextLanes.put(MAIN_SURFACE, main.withRaw(NO_COORDINATES));
                return previous.withLanes(nextLanes);
            });
        }
    }

    /**
     * The module holding {@code claim} is gone. Drops every surface but the
     * main one, unless a newer runtime has already claimed the store.
     */
    synchronized void releaseRuntime(final int claim) {
        if (claim == runtime) {
            dropNonMainSurfaces();
        }
    }

    /** How many surfaces other than the main one hold rectangles, on every display. */
    int nonMainSurfacesWithRectangles() {
        int count = 0;
        for (final Snapshot snapshot : byDisplay.values()) {
            for (final java.util.Map.Entry<Integer, Lane> entry : snapshot.lanes.entrySet()) {
                if (entry.getKey() != MAIN_SURFACE && entry.getValue().raw.length > 0) {
                    count++;
                }
            }
        }
        return count;
    }

    /** Drops every surface but the main one, on every display. */
    private void dropNonMainSurfaces() {
        for (final Integer display : byDisplay.keySet()) {
            update(display, previous -> {
                if (previous.lanes.isEmpty()
                        || (previous.lanes.size() == 1 && previous.lanes.containsKey(MAIN_SURFACE))) {
                    return previous;
                }
                final TreeMap<Integer, Lane> nextLanes = new TreeMap<>();
                final Lane main = previous.lanes.get(MAIN_SURFACE);
                if (main != null) {
                    nextLanes.put(MAIN_SURFACE, main);
                }
                return previous.withLanes(nextLanes);
            });
        }
    }

    /**
     * {@link #forgetOrigin}, by the module holding {@code claim}: ignored when
     * a newer runtime has claimed the store since.
     */
    synchronized void forgetOriginForRuntime(final int claim, final int surface) {
        if (isCurrentLocked(claim)) {
            forgetOrigin(surface);
        }
    }

    /**
     * {@link #dropSurfaceIfEmpty}, by the module holding {@code claim}: ignored
     * when a newer runtime has claimed the store since.
     */
    synchronized void dropSurfaceIfEmptyForRuntime(final int claim, final int surface) {
        if (isCurrentLocked(claim)) {
            dropSurfaceIfEmpty(surface);
        }
    }

    /** Whether {@code display}'s real size has been recorded. */
    boolean hasDisplayBounds(final int display) {
        final Snapshot current = byDisplay.get(display);
        return current != null && current.bounds != null;
    }

    /**
     * {@code surface}'s root is gone: its origin no longer holds, so every
     * display serves its rectangles as the whole display again until a new
     * origin is read. An empty lane is unaffected.
     */
    void forgetOrigin(final int surface) {
        for (final Integer display : byDisplay.keySet()) {
            update(display, previous -> {
                final Lane lane = previous.lanes.get(surface);
                if (lane == null || !lane.originKnown) {
                    return previous;
                }
                final TreeMap<Integer, Lane> nextLanes = new TreeMap<>(previous.lanes);
                nextLanes.put(surface, lane.withOriginUnknown());
                return previous.withLanes(nextLanes);
            });
        }
    }

    /** Whether {@code surface} holds rectangles on any display. */
    boolean hasRectangles(final int surface) {
        for (final Snapshot snapshot : byDisplay.values()) {
            final Lane lane = snapshot.lanes.get(surface);
            if (lane != null && lane.raw.length > 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * Forgets {@code surface} on every display where it holds no rectangles:
     * its root is gone, and a later root may reuse the key. A surface that
     * still holds rectangles stays (fails closed): only its owner clearing
     * them removes the redaction.
     */
    void dropSurfaceIfEmpty(final int surface) {
        if (surface == MAIN_SURFACE) {
            return;
        }
        for (final Integer display : byDisplay.keySet()) {
            update(display, previous -> {
                final Lane lane = previous.lanes.get(surface);
                if (lane == null || lane.raw.length > 0) {
                    return previous;
                }
                final TreeMap<Integer, Lane> nextLanes = new TreeMap<>(previous.lanes);
                nextLanes.remove(surface);
                return previous.withLanes(nextLanes);
            });
        }
    }

    /** Whether {@code surface} has a lane on any display. Tests and the tracker read it. */
    boolean hasSurface(final int surface) {
        for (final Snapshot snapshot : byDisplay.values()) {
            if (snapshot.lanes.containsKey(surface)) {
                return true;
            }
        }
        return false;
    }

    /**
     * {@code locationOnScreen} of a React root less React Native's viewport
     * offset for it: the display-pixel position of the origin
     * {@code measureInWindow} measures from on that surface.
     */
    @NonNull
    static int[] displayOrigin(@NonNull final int[] locationOnScreen,
            final int viewportX, final int viewportY) {
        return new int[] { locationOnScreen[0] - viewportX, locationOnScreen[1] - viewportY };
    }

    private interface LaneChange {
        @NonNull
        Lane apply(@NonNull Lane previous);
    }

    private interface Change {
        /** The next state, built from the current one; its version is ignored. */
        @NonNull
        Snapshot apply(@NonNull Snapshot previous);
    }

    @NonNull
    private static Snapshot withLane(@NonNull final Snapshot previous, final int surface,
            @NonNull final LaneChange change) {
        final TreeMap<Integer, Lane> nextLanes = new TreeMap<>(previous.lanes);
        final Lane prior = nextLanes.get(surface);
        final Lane base = prior == null ? new Lane(NO_COORDINATES, 0, 0, false) : prior;
        nextLanes.put(surface, change.apply(base));
        return previous.withLanes(nextLanes);
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
