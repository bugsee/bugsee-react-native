import { ancestryOfInstance, clipToAncestors, clipWatchNodes, isHidden, screensHide } from './ancestry';
import type { Ancestry } from './ancestry';
import { CoverageHold } from './hold';
import { addFrameMeasurer, addMeasurer, addParked, watchNode, watchValue } from './measureLoop';
import { whenMoved } from './drivers';
import { nativeMotion, throughMotion } from './nativeAnimation';
import { clearOwner, setOwnerRectangles } from './registry';
import { surfaceOfInstance } from './surface';
import {
  SECURE_TRANSITION_HOLD_MS,
  bounding,
  carriedCover,
  carriedCovers,
  carrierEntering,
  carrierLeaving,
  carriersOf,
  joinStack,
  keyOf,
  modalOf,
  observeStack,
  screenCover,
  screenRect,
  screensOn,
  stackMotionOf,
  stackMoving,
} from './transition';
import type { Carrier, StackChange } from './transition';
import { errorName } from '../errorName';
import type { FiberLike, WindowRect } from '../viewtree/fiber';

/** How many frames running a moving view's rectangle must stay put before it leaves the per-frame re-measure. */
export const STEADY_FRAMES = 10;

type MeasureInWindow = (callback: (x: number, y: number, width: number, height: number) => void) => void;

/**
 * How a mounted, enabled view is kept measured:
 *  - `tick`: wholly visible; re-measured on the 100 ms tick, as on main.
 *  - `active`: moving, or just shown, clipped or carried in by a transition,
 *    or under an `Animated` component; re-measured every frame until its
 *    rectangle has stayed put for {@link STEADY_FRAMES} frames (under an
 *    `Animated` component, always: a native animation can start, or its value
 *    jump, on any frame, and only its nodes tell).
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
  /** The `<Modal>` the view is in (`null`: none), read once a mount; `undefined` until then. */
  private modal: Carrier | null | undefined;
  /** Its `<Modal>` was last seen committed as not visible: closing, and already covered. */
  // Stryker disable next-line BooleanLiteral -- `start` clears it before anything reads it
  private closing = false;
  /** A transition carrying the view in, until `until`. */
  private carried: { readonly carriers: readonly Carrier[]; readonly until: number } | null = null;
  /** Where a transition can carry the view, published with the rest until `until`. */
  private cover: { readonly rect: WindowRect; readonly until: number } | null = null;
  /** Mounted by the commit now running: its first measurement looks for a transition carrying it in. */
  // Stryker disable next-line BooleanLiteral -- `start` sets it before anything reads it
  private arriving = false;
  /** Carried in by a transition: re-measured every frame until it settles, whatever mode it was in. */
  // Stryker disable next-line BooleanLiteral -- `start` clears it before anything reads it
  private settling = false;
  /** Under an `Animated` component: re-measured every frame. Set by every measurement. */
  // Stryker disable next-line BooleanLiteral -- every measurement sets it before `next` reads it
  private animating = false;
  /** What of the view was on screen at its last measurement (`null`: nothing); `undefined`: never measured. */
  private seen: WindowRect | null | undefined;
  /** The native values its transforms come from, watched for an animation starting. */
  // Stryker disable next-line ArrayDeclaration -- the first watch replaces it whatever it holds
  private values: object[] = [];
  /** Whether each of `values` may be native, as last watched. */
  // Stryker disable next-line ArrayDeclaration -- the first watch replaces it whatever it holds
  private natives: boolean[] = [];
  private unwatchValues: Array<() => void> = [];
  /** Leaves the stacks its screens are on. */
  private leaveStacks: Array<() => void> = [];
  /** The screens on each stack its screens are on, by the stack's place in the path, as last seen. */
  private stackScreens = new Map<number, Map<object, unknown>>();
  /** Frames (or checks) in a row the visible rectangle stayed put. */
  private steady = 0;
  private lastVisible: string | undefined;
  private lastSelf: string | undefined;
  // Stryker disable next-line ArrayDeclaration -- the first watch replaces it whatever it holds
  private watched: FiberLike[] = [];
  private unwatch: Array<() => void> = [];
  private unwatchModal: (() => void) | undefined;
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
    let cover: WindowRect | null = null;
    // The fiber tree and props are read as they are: a getter can throw.
    this.attempt(() => {
      if (above !== null) {
        const leaving = carriersOf(above).filter((carrier) => carrierLeaving(above, carrier));
        cover = carriedCovers(above, leaving, this.seen);
        const replaced = this.replacedBy(above, leaving);
        if (replaced !== null) {
          cover = bounding(replaced, cover);
        }
        this.tellStacks(above, leaving, now + SECURE_TRANSITION_HOLD_MS, true);
      }
    });
    this.leave();
    if (cover !== null) {
      // Joined with a cover still running (a push it was carried in by), the later end kept.
      // Only drops a cover run out: what it returns is not used.
      // Stryker disable next-line ArrayDeclaration
      this.covering([], now);
      const until = Math.max(now + SECURE_TRANSITION_HOLD_MS, this.cover?.until ?? 0);
      this.cover = { rect: bounding(cover, this.cover?.rect), until };
    }
    const rectangles = this.covering(this.hold.update(null, now), now);
    if (rectangles.length === 0) {
      clearOwner(this.token);
      return;
    }
    this.publish(rectangles);
    this.removeTick = addMeasurer(() => this.onDeparted());
  }

  /**
   * A screen popped as another is pushed onto its stack in the same commit
   * (a `replace`) is animated out by the incoming screen's animation, not its
   * own: where that can draw the view, or `null` when no screen came.
   */
  private replacedBy(above: Ancestry, leaving: readonly Carrier[]): WindowRect | null {
    let cover: WindowRect | null = null;
    for (const carrier of leaving) {
      // A Modal (no stack), or a stack never read: nothing to compare with.
      const before = this.stackScreens.get(carrier.stack as number);
      if (before === undefined) {
        continue;
      }
      const stack = above.path[carrier.stack as number] as FiberLike;
      // The commit's own stack fiber may be either of the pair.
      const now = [stack, stack.alternate].flatMap((fiber) => (fiber == null ? [] : [...screensOn(fiber)]));
      // Either fiber of the pair measures the same host.
      const screen = screenRect(above.path[carrier.index] as FiberLike);
      for (const [key, props] of now) {
        if (!before.has(key)) {
          // As the screen below a push: a slide up leaves it where it is; anything not known, the whole screen.
          // Its stack was read, so it was measured.
          const moved = screenCover(stackMotionOf(props, false), screen, this.seen as WindowRect | null, false);
          // Null only for a view seen nowhere, and then for every screen: the cover stays null either way.
          // Stryker disable next-line ConditionalExpression
          if (moved !== null) {
            cover = bounding(moved, cover);
          }
        }
      }
    }
    return cover;
  }

  /** Leaves every loop and forgets everything, without publishing. */
  private forget(): void {
    this.leave();
    this.surface = null;
    this.ancestry = null;
    this.hold.clear();
    this.cover = null;
    this.carried = null;
    this.modal = undefined;
    this.closing = false;
    this.seen = undefined;
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
    this.unwatchModal?.();
    this.unwatchModal = undefined;
    this.watchValues([]);
    // Off the stacks: a stopped view ignores what it is told anyway, so this only frees it.
    // Stryker disable next-line all -- so its mutants are equivalent
    this.leaveStacks.forEach((leave) => leave());
    this.leaveStacks = [];
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
      // The ancestry first: a view popped before its first measurement answers still knows its screen.
      this.ancestry ??= ancestryOfInstance(view);
      this.surface ??= surfaceOfInstance(view);
      const above = this.ancestry;
      if (this.modal === undefined) {
        this.watchModal(above);
        this.joinStacks(above);
      }
      if (isHidden(above)) {
        // Not drawn while hidden (seen nowhere: no stack change covers anything): whatever carries it in is
        // looked for once it is shown, and its stacks are read, so a pop that uncovers it is seen, whoever else
        // sees it.
        this.seen = null;
        this.noteBirths(above);
        this.attempt(() => this.checkStacks(above, monotonicNow()));
        this.publish(this.covering(this.hold.update(null, monotonicNow()), monotonicNow()));
        this.watch([]);
        this.enter('hidden');
        return;
      }
      // Shown again: perhaps by a transition still running. (Looking again on any other
      // measurement finds the same transitions: only a cost.)
      // Stryker disable all -- so its mutants are equivalent
      if (this.mode === 'hidden') {
        this.arriving = true;
      }
      // Stryker restore all
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
    const now = monotonicNow();
    // Where native-driven transforms can draw it, which the shadow tree never sees.
    const motion = nativeMotion(above);
    const { drawn, visible } =
      motion === null ? { drawn: self, visible: clipToAncestors(self, above) } : throughMotion(self, above, motion);
    this.seen = visible;
    // Read the stacks once seen: a cover for the screens moving above or below goes out with this publish.
    // Warned about once a view: the same unreadable tree warns from wherever it is read first.
    // Stryker disable all
    try {
      this.checkStacks(above, now);
    } catch (error) {
      this.failed(error);
    }
    // Stryker restore all
    // Per frame while a native animation runs; otherwise woken the frame one starts.
    this.animating = motion?.running ?? false;
    this.watchValues(motion?.roots ?? []);
    // Stryker disable next-line ConditionalExpression -- as when shown again: arriving again only costs
    if (this.arriving) {
      this.arrive(above, now);
    }
    if (this.carried !== null) {
      this.carry(visible, above, now);
    }
    if (this.modal) {
      this.watchClosing(visible, above, now);
    }
    this.publish(this.covering(this.hold.update(visible, now), now));
    const clipped = visible === null || visible.width < drawn.width || visible.height < drawn.height;
    const at = where(visible);
    this.steady = at === this.lastVisible ? this.steady + 1 : 0;
    this.lastVisible = at;
    this.watch(clipped ? clipWatchNodes(above) : []);
    this.enter(this.next(clipped));
  }

  /** Mounted: is a transition carrying it in? Then it is followed every frame until it settles. */
  private arrive(above: Ancestry, now: number): void {
    // Stryker disable next-line BooleanLiteral -- as above
    this.arriving = false;
    // As in `depart`: a read that throws carries nothing, and the view is still published.
    this.attempt(() => {
      let until = 0;
      const carriers = carriersOf(above).filter((carrier) => {
        const ends = carrierEntering(above, carrier, now);
        until = Math.max(until, ends ?? 0);
        return ends !== undefined;
      });
      if (carriers.length > 0) {
        this.carried = { carriers, until };
        // Read by its own view before and after (as it is carried in): telling it leaving changes nothing it keeps.
        // Stryker disable next-line BooleanLiteral
        this.tellStacks(above, carriers, until, false);
        // A Modal's content is laid out again once its dialog is up: within a frame.
        this.settling = true;
      }
    });
  }

  /**
   * Finds the `<Modal>` the view is in, hidden or not, and watches its host's
   * props, which change the commit that hides it: woken within a frame.
   */
  private watchModal(above: Ancestry): void {
    this.modal = null;
    try {
      this.modal = modalOf(above);
    } catch {
      // A tree that cannot be read: no Modal to watch (the measurement says why, once).
    }
    if (this.modal) {
      const host = above.path[this.modal.index] as FiberLike;
      // Stryker disable next-line StringLiteral -- woken in any mode but tick or parked, it is measured that frame
      this.unwatchModal = watchNode(host, () => this.enter('active'), false);
    }
  }

  /**
   * A `<Modal>` set `visible={false}` and still mounted (iOS keeps it until
   * `onDismiss`) slides out with the view in it: from the commit that hides
   * it, covers the band below the view for the transition hold, as an
   * unmount does where the Modal is removed at once (Android).
   */
  private watchClosing(self: WindowRect | null, above: Ancestry, now: number): void {
    const carrier = this.modal as Carrier;
    const host = (above.resolved ?? above.path)[carrier.index];
    const hidden = (host?.memoizedProps as { visible?: unknown } | null | undefined)?.visible === false;
    if (hidden && !this.closing) {
      const cover = carriedCover(above, carrier, self);
      if (cover !== null) {
        // A later deadline already set (a neighbour's push) is kept: the later transition still runs.
        const until = Math.max(now + SECURE_TRANSITION_HOLD_MS, this.cover?.until ?? 0);
        this.cover = { rect: bounding(cover, this.cover?.rect), until };
      }
    }
    this.closing = hidden;
  }

  /**
   * While a transition carries it in: covers where that can draw it from
   * where it rests now, as well as from where it rested before (a Modal's
   * content laid out again moves the band), until the transition hold ends.
   */
  private carry(self: WindowRect | null, above: Ancestry, now: number): void {
    const { carriers, until } = this.carried as { carriers: readonly Carrier[]; until: number };
    // Past it, the cover set below would be dropped as soon as it is published.
    // Stryker disable next-line ConditionalExpression,BlockStatement,EqualityOperator -- so carrying on changes nothing
    if (until <= now) {
      this.carried = null;
      return;
    }
    // Not laid out yet (0x0), or cut away: drawn nowhere, so nothing to cover from it.
    if (self === null || self.width <= 0 || self.height <= 0) {
      return;
    }
    let cover: WindowRect | null;
    try {
      cover = carriedCovers(above, carriers, self);
    } catch (error) {
      // Warned once, as in `measured`.
      // Stryker disable next-line all
      this.failed(error);
      return;
    }
    if (cover !== null) {
      // A later deadline (a neighbour's push or pop, a close) is kept: that transition still runs.
      this.cover = { rect: bounding(cover, this.cover?.rect), until: Math.max(until, this.cover?.until ?? 0) };
    }
  }

  /** Records the transitions creating its carriers, for when it is shown while they run. */
  private noteBirths(above: Ancestry): void {
    try {
      carriersOf(above).forEach((carrier) => carrierEntering(above, carrier, monotonicNow()));
    } catch {
      // Unreadable: nothing recorded; the measurement says why, once.
    }
  }

  /** Joins the stacks its screens are on, to be told when another screen on one moves. */
  private joinStacks(above: Ancestry): void {
    try {
      for (const carrier of carriersOf(above)) {
        // Only the Modal, last, has no stack: failing on it, after the screens, joins them all the same.
        // Stryker disable next-line ConditionalExpression -- so its mutant is equivalent
        if (carrier.stack !== undefined) {
          const stack = keyOf(above.path[carrier.stack] as FiberLike);
          const told = (change: StackChange): void => this.screenMoved(carrier, change);
          this.leaveStacks.push(joinStack(stack, told));
          // A commit that pushes or pops a screen re-renders the stack: woken within a frame.
          // Measuring the stack as well only wakes it more often; any mode but tick or parked measures that frame.
          // Stryker disable next-line StringLiteral,BooleanLiteral
          this.leaveStacks.push(watchNode(above.path[carrier.stack] as FiberLike, () => this.enter('active'), false));
        }
      }
    } catch {
      // Unreadable: no stacks joined; the measurement says why, once.
    }
  }

  /** Tells the stacks of the screens in `carriers` that those screens are popped (`leaving`) or pushed. */
  private tellStacks(above: Ancestry, carriers: readonly Carrier[], until: number, leaving: boolean): void {
    const fibers = above.resolved ?? above.path;
    for (const carrier of carriers) {
      if (carrier.stack !== undefined) {
        const screen = fibers[carrier.index] as FiberLike;
        const stack = keyOf(above.path[carrier.stack] as FiberLike);
        const motion = stackMotionOf(screen.memoizedProps, false);
        stackMoving(stack, { motion, until, moving: keyOf(screen), below: undefined }, leaving);
      }
    }
  }

  /**
   * Reads the stacks its screens are on: a screen pushed onto, or popped
   * off, one (with or without a `<BugseeSecure>` of its own) since any view
   * last read it is recorded for it. Seen on screen, it covers every change
   * still in its hold that moves its own screen, uncovered or covered, from
   * where it is now: also one made before it mounted, or while it was hidden.
   */
  private checkStacks(above: Ancestry, now: number): void {
    const fibers = above.resolved ?? above.path;
    for (const carrier of carriersOf(above)) {
      if (carrier.stack === undefined) {
        continue;
      }
      const stack = fibers[carrier.stack] as FiberLike;
      const screens = screensOn(stack);
      this.stackScreens.set(carrier.stack, screens);
      observeStack(stack, screens, now).forEach((change) => this.screenMoved(carrier, change));
    }
  }

  /**
   * Another screen on a stack its screen is on is pushed or popped: its own
   * screen, uncovered or covered, moves too, as `change.motion` until
   * `change.until`. Covered from where it is seen now, joined with where it
   * was: every measurement in the hold follows it.
   */
  private screenMoved(carrier: Carrier, change: StackChange): void {
    const above = this.ancestry as Ancestry;
    const screen = above.path[carrier.index] as FiberLike;
    const key = keyOf(screen);
    // A stopped view has left its stacks; a view on the moving screen is carried, over as much (each motion
    // covers the screen moving at least as much as the one below).
    // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement -- so these tests only spare work
    if (!this.running || change.moving === key) {
      return;
    }
    // Seen nowhere, nothing to cover; a change that uncovers or covers another screen does not move its own.
    if (this.seen == null || (change.below !== undefined && change.below !== key)) {
      return;
    }
    // Seen on screen, so covered somewhere.
    const cover = screenCover(change.motion, screenRect(screen), this.seen, false) as WindowRect;
    // Whatever cover is still running is joined, not replaced; one run out is dropped first.
    // A run-out cover is dropped on the next publish anyway.
    // Stryker disable next-line all -- so these are equivalent
    this.covering([], monotonicNow());
    const kept = this.cover;
    this.cover = { rect: bounding(cover, kept?.rect), until: Math.max(change.until, kept?.until ?? 0) };
    this.republish();
  }

  /**
   * Watches `nodes` (the values its transforms come from): measured at once
   * when JS moves one (where that is followed), and, for a native one, woken
   * the frame its fields show a change native made (an animation ending).
   */
  private watchValues(nodes: readonly object[]): void {
    const natives = nodes.map((node) => (node as { __isNative?: unknown }).__isNative !== false);
    // Watching the same values again takes their state now as the baseline, as the frame just did: only work. A
    // value made native since is polled from then on; JS moving it is followed, so that only adds a safety net.
    const same = (node: object, index: number): boolean =>
      // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator -- as above
      node === this.values[index] && natives[index] === this.natives[index];
    // Stryker disable next-line ConditionalExpression,MethodExpression,EqualityOperator,BlockStatement -- as above
    if (nodes.length === this.values.length && nodes.every(same)) {
      return;
    }
    this.unwatchValues.forEach((stop) => stop());
    this.values = [...nodes];
    this.natives = natives;
    // Stryker disable next-line StringLiteral -- woken in any mode but tick or parked, it is measured that frame
    const wake = (): void => this.enter('active');
    // Measured now: it goes active if it finds an animation running.
    const now = (): void => this.measure();
    this.unwatchValues = this.values.flatMap((node, index) => {
      const told = whenMoved(node, now);
      // Driven from JS, it keeps no frame loop where JS moving it is followed.
      return told === undefined ? [watchValue(node, wake)] : natives[index] ? [told, watchValue(node, wake)] : [told];
    });
  }

  private next(clipped: boolean): Mode {
    if (this.mode === 'active') {
      if (this.steady < STEADY_FRAMES || this.animating || this.carried !== null) {
        return 'active';
      }
      this.settling = false;
      return clipped ? 'parked' : 'tick';
    }
    // Carried in is also settling: per frame.
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

  /** Runs `run`; what it throws is warned about, once a view, and stops nothing else. */
  private attempt(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.failed(error);
    }
  }

  private failed(error: unknown): void {
    if (!this.warned) {
      this.warned = true;
      console.warn('[Bugsee] BugseeSecure could not measure', errorName(error));
    }
  }
}
