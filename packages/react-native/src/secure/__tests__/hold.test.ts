/**
 * Coverage is added at once and removed late: what a view stopped covering
 * stays published for SECURE_SHRINK_HOLD_MS, because native may still draw it
 * there for a while after the shadow tree moved on.
 */
import { CoverageHold, SECURE_SHRINK_HOLD_MS } from '../hold';
import type { WindowRect } from '../../viewtree/fiber';

const rect = (x: number, y: number, width: number, height: number): WindowRect => ({ x, y, width, height });
const A = rect(0, 0, 10, 10);
const B = rect(20, 0, 10, 10);
const C = rect(40, 0, 10, 10);

describe('CoverageHold', () => {
  it('holds 500 ms', () => {
    expect(SECURE_SHRINK_HOLD_MS).toBe(500);
  });

  it('publishes nothing, and holds nothing, before anything is covered', () => {
    expect(new CoverageHold().holding()).toBe(false);
    expect(new CoverageHold().update(null, 1_000)).toEqual([]);
  });

  it('publishes what is covered now, at once', () => {
    const hold = new CoverageHold();

    expect(hold.update(A, 1_000)).toEqual([A]);
    expect(hold.holding()).toBe(false);
  });

  it('an unchanged rectangle holds nothing', () => {
    const hold = new CoverageHold();
    hold.update(A, 1_000);

    expect(hold.update({ ...A }, 1_050)).toEqual([A]);
    expect(hold.holding()).toBe(false);
  });

  it.each([
    ['x', rect(1, 0, 10, 10)],
    ['y', rect(0, 1, 10, 10)],
    ['width', rect(0, 0, 9, 10)],
    ['height', rect(0, 0, 10, 9)],
  ])('holds the old rectangle when its %s changes', (_, moved) => {
    const hold = new CoverageHold();
    hold.update(A, 1_000);

    expect(hold.update(moved, 1_010)).toEqual([moved, A]);
    expect(hold.holding()).toBe(true);
  });

  it('holds what it stopped covering for at least SECURE_SHRINK_HOLD_MS, then drops it', () => {
    const hold = new CoverageHold();
    hold.update(A, 1_000);
    // Left at 1050, in the 1000-1099 window: held until 1100 + 500.
    hold.update(null, 1_050);

    expect(hold.publishable(1_550)).toEqual([A]);
    expect(hold.publishable(1_599)).toEqual([A]);
    expect(hold.publishable(1_600)).toEqual([]);
    expect(hold.holding()).toBe(false);
  });

  it('collects what left within one window into one box', () => {
    const hold = new CoverageHold();
    hold.update(A, 1_000);
    hold.update(B, 1_010);
    hold.update(C, 1_020);

    expect(hold.publishable(1_030)).toEqual([C, rect(0, 0, 30, 10)]);
  });

  it('keeps a box per window, each dropped on its own', () => {
    const hold = new CoverageHold();
    hold.update(A, 1_000);
    hold.update(B, 1_050);
    hold.update(C, 1_150);

    expect(hold.publishable(1_160)).toEqual([C, A, B]);
    expect(hold.publishable(1_600)).toEqual([C, B]);
    expect(hold.publishable(1_700)).toEqual([C]);
  });

  it('grows a box on every side', () => {
    const hold = new CoverageHold();
    hold.update(rect(10, 10, 10, 10), 1_000);
    hold.update(rect(0, 0, 5, 5), 1_010);
    hold.update(rect(30, 40, 5, 5), 1_020);
    hold.update(null, 1_030);

    expect(hold.publishable(1_040)).toEqual([rect(0, 0, 35, 45)]);
  });

  it('hidden and shown again within the hold, it never stops covering', () => {
    const hold = new CoverageHold();
    hold.update(A, 1_000);

    expect(hold.update(null, 1_100)).toEqual([A]);
    expect(hold.update(A, 1_400)).toEqual([A, A]);
  });

  it('clear forgets everything at once', () => {
    const hold = new CoverageHold();
    hold.update(A, 1_000);
    hold.update(B, 1_010);

    hold.clear();

    expect(hold.holding()).toBe(false);
    expect(hold.publishable(1_020)).toEqual([]);
  });
});
