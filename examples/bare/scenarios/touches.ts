/**
 * The touch-capture scenario (e2e/touches.test.ts).
 *
 * After `Launched` it logs `ready`, gives the test a fixed window to tap and
 * swipe the screen with the platform's input tool, then uploads one report
 * and logs `uploaded`. The scenario renders nothing of its own: the touches
 * land on the example app and only the SDK's recording of them matters.
 */
import Bugsee from '@bugsee/react-native';

export const TOUCHES_SCENARIOS = ['touch-capture'] as const;

export type TouchesScenario = (typeof TOUCHES_SCENARIOS)[number];

export function isTouchesScenario(name: string): name is TouchesScenario {
  return (TOUCHES_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E touches ${message}`);
}

/** How long the test has to tap and swipe before the report is taken. */
export const TOUCH_WINDOW_MS = 20_000;

export function runTouchesScenario(nonce: string): void {
  mark(`ready window=${TOUCH_WINDOW_MS} nonce=${nonce}`);
  setTimeout(() => {
    Bugsee.upload(`touch-capture-${nonce}`, '');
    mark(`uploaded nonce=${nonce}`);
  }, TOUCH_WINDOW_MS);
}
