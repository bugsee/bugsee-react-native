import { insertSymbolicatePrebuilt, removeSymbolicatePrebuilt } from '../podfile';

const PODFILE = "require 'json'\nplatform :ios, '16.4'\n";

describe('podfile edit', () => {
  it('adds the marked line once and removes it again', () => {
    const once = insertSymbolicatePrebuilt(PODFILE);
    expect(once).toContain("ENV['RCT_SYMBOLICATE_PREBUILT_FRAMEWORKS'] ||= '1'");
    expect(insertSymbolicatePrebuilt(once)).toBe(once);
    expect(removeSymbolicatePrebuilt(once)).toBe(PODFILE);
  });

  it('leaves a Podfile without the block untouched on removal', () => {
    expect(removeSymbolicatePrebuilt(PODFILE)).toBe(PODFILE);
  });

  it('uses ||= so an explicit value from the environment wins', () => {
    expect(insertSymbolicatePrebuilt('')).toMatch(/\|\|= '1'/);
  });
});
