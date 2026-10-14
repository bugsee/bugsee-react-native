import { ancestryOfInstance, clipToAncestors, clipWatchNodes, isHidden, screensHide } from './ancestry';
import type { Ancestry } from './ancestry';
import { CoverageHold } from './hold';
import { addFrameMeasurer, addMeasurer, addParked, watchNode } from './measureLoop';
import { nativeMotion } from './nativeAnimation';
import { clearOwner, setOwnerRectangles } from './registry';
import { surfaceOfInstance } from './surface';
import { SECURE_TRANSITION_HOLD_MS, carriedCover, carrierEntering, carrierLeaving, carrierOf } from './transition';
import { errorName } from '../errorName';
import type { FiberLike, WindowRect } from '../viewtree/fiber';

/** How many frames running a moving view's rectangle must stay put before it leaves the per-frame re-measure. */
export const STEADY_FRAMES = 10;

type MeasureInWindow = (callback: (x: number, y: number, width: number, height: number) => void) => void;

/**
 * How a mounted, enabled view is kept measured:
 *  - `tick`: wholly visible; re-measured on the 100 ms tick, as on main.
 *  - `active`: moving, or just shown, clipped or carried in by a transition,
 *    or under a running native-driven animation; re-measured every frame
 *    until its rectangle has stayed put for {@link STEADY_FRAMES} frames (and
 *    no native animation runs).
 *  - `parked`: clipped and still. Its clipping nodes (a ScrollView and its
 *    content, a clipping view) are watched every frame, shared with every
 *    view under them, and a move wakes it; each frame also asks whether its
 *    screens hide it (once per screen a frame); every tick re-checks it by
 *    measuring the view alone.
 *  - `hidden`: withdrawn under an inactive screen; each frame asks only
 *    whether the screens still hide it (once a frame per screen), and
 *    measures again the frame they do not.
 */
type Mode = 'tick' | 'active' | 'parked' | 'hidden';

/**
 * Milliseconds on a clock that only goes forward: the hold must not end
 * early because the wall clock was set forward (NTP, the user). Falls back
 * to `Date.now` where there is no `performance.now`.
 */
export function monotonicNow(): number {
  const { performance: perf } = globalThis as { performance?: { now?: () => number } };
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

function where(rect: WindowRect | null): string {
  // Stryker disable next-line StringLiteral -- any marker no rectangle reads as does
  return rect === null ? 'none' : `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

/**
 * One `<BugseeSecure>`'s measuring and publishing, from mount (`start`) to
 * unmount (`depart`) or disable (`stop`). Coverage is added at once and
 * removed late (see `SECURE_SHRINK_HOLD_MS`), unmounting included: native
 * draws the view until it mounts the commit that removed it, and a
 * transition that carries it out draws it longer (see
 * `SECURE_TRANSITION_HOLD_MS`). Only `stop`, an explicit disable, removes it
 * at once.
 */
export class SecureTracker {
  private running = false;
  private warned = false;
  // Stryker disable next-line StringLiteral -- any mode but active, hidden or parked starts it on no loop
  private mode: Mode = 'tick';
  private surface: number | null = null;
  private ancestry: Ancestry | null = null;
  private readonly hold = new CoverageHold();
  /** Where a transition can carry the view, published with the rest until `until`. */
  private cover: { readonly rect: WindowRect; readonly until: number } | null = null;
  /** Mounted by the commit now running: its first measurement looks for a transition carrying it in. */
  // Stryker disable next-line BooleanLiteral -- `start` sets it before anything reads it
  private arriving = false;
  /** Carried in by a transition: re-measured every frame until it settles, whatever mode it was in. */
  // Stryker disable next-line BooleanLiteral -- `start` clears it before anything reads it
  private settling = false;
  /** Under a running native-driven animation: re-measured every frame. Set by every measurement. */
  // Stryker disable next-line BooleanLiteral -- every measurement sets it before `next` reads it
  private animating = false;
  /** The view's last measured rectangle, unclipped. */
  private lastRect: WindowRect | null = null;
  /** Frames (or checks) in a row the visible rectangle stayed put. */
  private steady = 0;
  private lastVisible: string | undefined;
  private lastSelf: string | undefined;
  // Stryker disable next-line ArrayDeclaration -- the first watch replaces it whatever it holds
  private watched: FiberLike[] = [];
  private unwatch: Array<() => void> = [];
  private removeTick: (() => void) | undefined;
  private removeFrame: (() => void) | undefined;
  private removeParked: (() => void) | undefined;

  constructor(
    private readonly view: () => { measureInWindow: MeasureInWindow } | null,
    private readonly token: object,
  ) {}

  start(): void {
    // A remount of the same instance (StrictMode) ends what its unmount left.
    this.forget();
    this.running = true;
    this.arriving = true;
    this.measure();
    this.removeTick = addMeasurer(() => this.onTick());
  }

  /** Disabled: nothing is covered from now on, at once. */
  stop(): void {
    this.forget();
    clearOwner(this.token);
  }

  /**
   * Unmounted: covers what it covered, and where a transition carrying it out
   * can still draw it, until that has been held long enough; then removes
   * it. Called from the unmounting commit, so its deletions can be read.
   */
  depart(): void {
    if (!this.running) {
      return;
    }
    const now = monotonicNow();
    const above = this.ancestry;
    const last = this.lastRect;
    let cover: WindowRect | null = null;
    // The fiber tree and props are read as they are: a getter can throw.
    try {
      const carrier = above === null ? null : carrierOf(above);
      if (carrier !== null && carrierLeaving(above as Ancestry, carrier)) {
        cover = carriedCover(above as Ancestry, carrier, last);
      }
    } catch (error) {
      this.failed(error);
    }
    this.leave();
    if (cover !== null) {
      this.cover = { rect: cover, until: now + SECURE_TRANSITION_HOLD_MS };
    }
    const rectangles = this.covering(this.hold.update(null, now), now);
    if (rectangles.length === 0) {
      clearOwner(this.token);
      return;
    }
    this.publish(rectangles);
    this.removeTick = addMeasurer(() => this.onDeparted());
  }

  /** Leaves every loop and forgets everything, without publishing. */
  private forget(): void {
    this.leave();
    this.surface = null;
    this.ancestry = null;
    this.hold.clear();
    this.cover = null;
    this.lastRect = null;
  }

  /** Stops measuring: off every loop, as if never started. */
  private leave(): void {
    this.running = false;
    this.settling = false;
    this.removeTick?.();
    this.removeTick = undefined;
    // Stryker disable next-line StringLiteral -- any mode but active, hidden or parked leaves every loop
    this.enter('tick');
    this.watch([]);
    this.steady = 0;
    this.lastVisible = undefined;
    this.lastSelf = undefined;
  }

  /** The tick after unmounting: publishes what is still held, and removes it all once nothing is. */
  private onDeparted(): void {
    const rectangles = this.covering(this.hold.publishable(monotonicNow()), monotonicNow());
    if (rectangles.length === 0) {
      this.forget();
      clearOwner(this.token);
    } else {
      this.publish(rectangles);
    }
  }

  /** `rectangles` and, while it lasts, the transition's cover. */
  private covering(rectangles: WindowRect[], now: number): WindowRect[] {
    // Stryker disable next-line EqualityOperator -- one millisecond either way, at the end of a second
    if (this.cover !== null && this.cover.until <= now) {
      this.cover = null;
    }
    return this.cover === null ? rectangles : [this.cover.rect, ...rectangles];
  }

  /** Measures the view and its clipping ancestors, and publishes what it covers. */
  measure(): void {
    const view = this.view();
    if (!this.running || view === null) {
      return;
    }
    try {
      this.surface ??= surfaceOfInstance(view);
      this.ancestry ??= ancestryOfInstance(view);
      const above = this.ancestry;
      if (isHidden(above)) {
        // Hidden as it mounts: whatever carried it in is not drawn.
        this.arriving = false;
        this.publish(this.covering(this.hold.update(null, monotonicNow()), monotonicNow()));
        this.watch([]);
        this.enter('hidden');
        return;
      }
      // Fabric answers every measurement at once, so the view and its
      // clipping ancestors are measured in the same layout. Paper answers
      // later, and its ancestors then cut nothing.
      view.measureInWindow((x, y, width, height) => {
        if (!this.running) {
          return;
        }
        try {
          this.measured({ x, y, width, height }, above);
        } catch (error) {
          this.failed(error);
        }
      });
    } catch (error) {
      this.failed(error);
    }
  }

  private measured(self: WindowRect, above: Ancestry): void {
    if (![self.x, self.y, self.width, self.height].every(Number.isFinite)) {
      // A failed measurement: the last rectangle stands.
      // Stryker disable next-line StringLiteral -- only the error's name is logged
      throw new RangeError('BugseeSecure measured a non-finite rectangle');
    }
    this.lastSelf = where(self);
    this.lastRect = self;
    const now = monotonicNow();
    if (this.arriving) {
      this.arrive(self, above, now);
    }
    // Where a native-driven animation can draw it, which the shadow tree never sees.
    const motion = nativeMotion(self, above);
    this.animating = motion?.running ?? false;
    const drawn = motion?.rect ?? self;
    const visible = clipToAncestors(drawn, above, motion?.above);
    this.publish(this.covering(this.hold.update(visible, now), now));
    const clipped = visible === null || visible.width < drawn.width || visible.height < drawn.height;
    const at = where(visible);
    this.steady = at === this.lastVisible ? this.steady + 1 : 0;
    this.lastVisible = at;
    this.watch(clipped ? clipWatchNodes(above) : []);
    this.enter(this.next(clipped));
  }

  /** Mounted with a transition carrying it in: covers where that can draw it, and follows it every frame. */
  private arrive(self: WindowRect, above: Ancestry, now: number): void {
    this.arriving = false;
    let cover: WindowRect | null;
    // As in `depart`: a read that throws carries nothing, and the view is still published.
    try {
      const carrier = carrierOf(above);
      if (carrier === null || !carrierEntering(above, carrier)) {
        return;
      }
      cover = carriedCover(above, carrier, self);
    } catch (error) {
      this.failed(error);
      return;
    }
    if (cover !== null) {
      this.cover = { rect: cover, until: now + SECURE_TRANSITION_HOLD_MS };
    }
    // A Modal's content is laid out again once its dialog is up: within a frame.
    this.settling = true;
  }

  private next(clipped: boolean): Mode {
    if (this.mode === 'active') {
      if (this.steady < STEADY_FRAMES || this.animating) {
        return 'active';
      }
      this.settling = false;
      return clipped ? 'parked' : 'tick';
    }
    if (this.mode === 'hidden' || this.settling || this.animating) {
      return 'active';
    }
    if (!clipped) {
      return 'tick';
    }
    return this.mode === 'parked' && this.steady > 0 ? 'parked' : 'active';
  }

  private onTick(): void {
    if (this.mode === 'tick') {
      this.measure();
    } else if (this.mode === 'parked' && this.changing()) {
      this.republish();
    }
  }

  /** Whether what is published will change on its own: something held, or a cover, runs out. */
  private changing(): boolean {
    return this.hold.holding() || this.cover !== null;
  }

  private republish(): void {
    const now = monotonicNow();
    this.publish(this.covering(this.hold.publishable(now), now));
  }

  private onFrame(): void {
    if (this.mode === 'active') {
      this.measure();
      return;
    }
    const hides = screensHide(this.ancestry as Ancestry);
    if (this.mode === 'parked') {
      // A screen that goes inactive moves nothing a watch would see.
      if (hides) {
        this.measure();
      }
      return;
    }
    // Hidden: once its screens stop hiding it, measure (which checks fully).
    if (!hides) {
      this.measure();
    } else if (this.changing()) {
      this.republish();
    }
  }

  /** The tick's turn for a parked view: the view alone; anything moved, measure it all. */
  private checkParked(): void {
    // Parked only while mounted, so the view is there.
    const view = this.view() as { measureInWindow: MeasureInWindow };
    view.measureInWindow((x, y, width, height) => {
      if (this.running && where({ x, y, width, height }) !== this.lastSelf) {
        this.measure();
      }
    });
  }

  private enter(mode: Mode): void {
    if (mode === this.mode) {
      return;
    }
    // Parked too, for its screens alone: once per screen a frame, or nothing.
    const perFrame = mode !== 'tick';
    if (!perFrame) {
      // Every mode but tick is on frames, so leaving one for tick has this.
      (this.removeFrame as () => void)();
      this.removeFrame = undefined;
    }
    // Entering parked from elsewhere, nothing parked is registered to remove.
    // Stryker disable next-line ConditionalExpression,StringLiteral -- so removing it anyway changes nothing
    if (mode !== 'parked') {
      this.removeParked?.();
      this.removeParked = undefined;
    }
    if (perFrame) {
      this.removeFrame ??= addFrameMeasurer(() => this.onFrame());
    }
    if (mode === 'parked') {
      this.removeParked = addParked(() => this.checkParked());
    }
    // A fresh count in every mode: woken back to active, it must stay put again.
    this.steady = 0;
    this.mode = mode;
  }

  /** Watches `nodes` (replacing what was watched) and wakes on any of them moving. */
  private watch(nodes: FiberLike[]): void {
    if (nodes.length === this.watched.length && nodes.every((node, index) => node === this.watched[index])) {
      return;
    }
    this.unwatch.forEach((stop) => stop());
    this.watched = nodes;
    // Any mode but tick or parked measures it the same frame and goes active.
    // Stryker disable next-line StringLiteral -- so another mode name changes nothing
    this.unwatch = nodes.map((node) => watchNode(node, () => this.enter('active')));
  }

  private publish(rectangles: WindowRect[]): void {
    // Set by the measure that got here.
    setOwnerRectangles(this.token, 0, rectangles, this.surface as number);
  }

  private failed(error: unknown): void {
    if (!this.warned) {
      this.warned = true;
      console.warn('[Bugsee] BugseeSecure could not measure', errorName(error));
    }
  }
}
