import type { WindowRect } from '../viewtree/fiber';

/**
 * How long a `<BugseeSecure>` keeps covering what it covered before it shrank,
 * moved or was hidden.
 *
 * `measureInWindow` and committed props describe the shadow tree; native
 * draws it a frame or more later, and a LayoutAnimation (`configureNext`, as
 * KeyboardAvoidingView uses, about 250 ms) only reaches its end state at the
 * end of the animation. Coverage taken away on shadow-tree evidence alone
 * could uncover a field native still draws where it was. So coverage is
 * added at once and removed late: what a view covered stays published for
 * this long after it stopped covering it, and a hidden view withdraws only
 * once it has been hidden this long without a break.
 */
export const SECURE_SHRINK_HOLD_MS = 500;

/** The width of one hold window: what leaves within one is held as one box. */
const WINDOW_MS = 100;

interface Held {
  /** The window this box collects what left during. */
  readonly window: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * One instance's coverage over time: the rectangle it covers now, and, per
 * {@link WINDOW_MS} window of the last {@link SECURE_SHRINK_HOLD_MS}, the
 * bounding box of what it stopped covering then. At most a handful of
 * boxes, however much the view moves.
 */
export class CoverageHold {
  private current: WindowRect | null = null;
  private held: Held[] = [];

  /**
   * Sets what the view covers now (`null`: nothing, hidden or cut away) and
   * returns everything to publish: the current rectangle and every held box.
   */
  update(visible: WindowRect | null, now: number): WindowRect[] {
    const previous = this.current;
    if (previous !== null && !sameRect(previous, visible)) {
      this.hold(previous, now);
    }
    this.current = visible;
    return this.publishable(now);
  }

  /** What to publish now, after dropping what has been held long enough. */
  publishable(now: number): WindowRect[] {
    this.held = this.held.filter((box) => (box.window + 1) * WINDOW_MS + SECURE_SHRINK_HOLD_MS > now);
    const out = this.held.map(({ left, top, right, bottom }) => ({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    }));
    return this.current === null ? out : [this.current, ...out];
  }

  /** Whether anything is still held: what is published will change on its own. */
  holding(): boolean {
    return this.held.length > 0;
  }

  /** Forgets everything, as unmounting or disabling does. */
  clear(): void {
    this.current = null;
    this.held = [];
  }

  private hold(rect: WindowRect, now: number): void {
    const window = Math.floor(now / WINDOW_MS);
    const last = this.held[this.held.length - 1];
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    if (last !== undefined && last.window === window) {
      last.left = Math.min(last.left, rect.x);
      last.top = Math.min(last.top, rect.y);
      last.right = Math.max(last.right, right);
      last.bottom = Math.max(last.bottom, bottom);
      return;
    }
    this.held.push({ window, left: rect.x, top: rect.y, right, bottom });
  }
}

function sameRect(a: WindowRect, b: WindowRect | null): boolean {
  return b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
