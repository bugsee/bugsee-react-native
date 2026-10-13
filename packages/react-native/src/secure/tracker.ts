import { ancestryOfInstance, clipToAncestors, clipWatchNodes, isHidden, screensHide } from './ancestry';
import type { Ancestry } from './ancestry';
import { CoverageHold } from './hold';
import { addFrameMeasurer, addMeasurer, addParked, watchNode } from './measureLoop';
import { clearOwner, setOwnerRectangles } from './registry';
import { surfaceOfInstance } from './surface';
import { errorName } from '../errorName';
import type { FiberLike, WindowRect } from '../viewtree/fiber';

/** How many frames running a moving view's rectangle must stay put before it leaves the per-frame re-measure. */
export const STEADY_FRAMES = 10;

type MeasureInWindow = (callback: (x: number, y: number, width: number, height: number) => void) => void;

/**
 * How a mounted, enabled view is kept measured:
 *  - `tick`: wholly visible; re-measured on the 100 ms tick, as on main.
 *  - `active`: moving, or just shown or clipped; re-measured every frame
 *    until its rectangle has stayed put for {@link STEADY_FRAMES} frames.
 *  - `parked`: clipped and still. Its clipping nodes (a ScrollView's
 *    content, a clipping view) are watched every frame, shared with every
 *    view under them, and a move wakes it; the tick also re-checks it, in
 *    turn, by measuring the view alone.
 *  - `hidden`: withdrawn under an inactive screen; each frame asks only
 *    whether the screens still hide it (once a frame per screen), and
 *    measures again the frame they do not.
 */
type Mode = 'tick' | 'active' | 'parked' | 'hidden';

function where(rect: WindowRect | null): string {
  // Stryker disable next-line StringLiteral -- any marker no rectangle reads as does
  return rect === null ? 'none' : `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

/**
 * One `<BugseeSecure>`'s measuring and publishing, from mount (`start`) to
 * unmount or disable (`stop`). Coverage is added at once and removed late
 * (see `SECURE_SHRINK_HOLD_MS`); `stop` removes it at once.
 */
export class SecureTracker {
  private running = false;
  private warned = false;
  // Stryker disable next-line StringLiteral -- any mode but active, hidden or parked starts it on no loop
  private mode: Mode = 'tick';
  private surface: number | null = null;
  private ancestry: Ancestry | null = null;
  private readonly hold = new CoverageHold();
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
    this.running = true;
    this.measure();
    this.removeTick = addMeasurer(() => this.onTick());
  }

  stop(): void {
    this.running = false;
    this.removeTick?.();
    this.removeTick = undefined;
    // Stryker disable next-line StringLiteral -- any mode but active, hidden or parked leaves every loop
    this.enter('tick');
    this.watch([]);
    this.surface = null;
    this.ancestry = null;
    this.hold.clear();
    this.steady = 0;
    this.lastVisible = undefined;
    this.lastSelf = undefined;
    clearOwner(this.token);
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
        this.publish(this.hold.update(null, Date.now()));
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
    const visible = clipToAncestors(self, above);
    this.publish(this.hold.update(visible, Date.now()));
    const clipped = visible === null || visible.width < self.width || visible.height < self.height;
    const now = where(visible);
    this.steady = now === this.lastVisible ? this.steady + 1 : 0;
    this.lastVisible = now;
    this.watch(clipped ? clipWatchNodes(above) : []);
    this.enter(this.next(clipped));
  }

  private next(clipped: boolean): Mode {
    if (this.mode === 'active') {
      if (this.steady < STEADY_FRAMES) {
        return 'active';
      }
      return clipped ? 'parked' : 'tick';
    }
    if (this.mode === 'hidden') {
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
    } else if (this.mode === 'parked' && this.hold.holding()) {
      this.publish(this.hold.publishable(Date.now()));
    }
  }

  private onFrame(): void {
    if (this.mode === 'active') {
      this.measure();
      return;
    }
    // Hidden: once its screens stop hiding it, measure (which checks fully).
    if (!screensHide(this.ancestry as Ancestry)) {
      this.measure();
    } else if (this.hold.holding()) {
      this.publish(this.hold.publishable(Date.now()));
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
    const perFrame = mode === 'active' || mode === 'hidden';
    if (!perFrame) {
      this.removeFrame?.();
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
