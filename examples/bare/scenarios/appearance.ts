/**
 * Phase 11: a report color and a collected-data deletion, after launch.
 *
 * `backgroundColor` exists on both platforms. The getter reads the SDK
 * back, so the logged color is what was stored, not the string we wrote.
 * `includingIntermediate` is the flag handed to
 * `deleteCollectedDataOnDevice`. While launched the SDK refuses the
 * deletion; the line still records the flag that crossed.
 */
import Bugsee from '@bugsee/react-native';

export const APPEARANCE_SCENARIOS = ['appearance'] as const;

export type AppearanceScenario = (typeof APPEARANCE_SCENARIOS)[number];

export function isAppearanceScenario(name: string): name is AppearanceScenario {
  return (APPEARANCE_SCENARIOS as readonly string[]).includes(name);
}

const COLOR = '#ff0000ff';

export async function runAppearanceScenario(nonce: string): Promise<void> {
  Bugsee.appearance.backgroundColor = COLOR;
  const read = Bugsee.appearance.backgroundColor ?? 'unread';
  const deleted = await Bugsee.deleteCollectedDataOnDevice(true);
  console.log(
    `BUGSEE_E2E appearance nonce=${nonce} background=${read} includingIntermediate=true deleted=${String(deleted)}`,
  );
}
