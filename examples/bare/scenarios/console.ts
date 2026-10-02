/**
 * The console-capture scenario Task 9.1 drives on a device
 * (e2e/console.test.ts).
 *
 * `console` prints one line through `console.log` after `Launched`, then
 * uploads. `launch()` has already installed the JS patch, so the line is
 * forwarded through the wrapper channel and the original console call still
 * prints — that print is the marker the e2e waits for.
 *
 * `duration` stays 90. This scenario returns before the example's relaunch
 * and does not pass its own launch options; App.tsx still launches with
 * `NON_DEFAULT_DURATION`.
 */
import Bugsee from '@bugsee/react-native';

export const CONSOLE_SCENARIOS = ['console'] as const;

export type ConsoleScenario = (typeof CONSOLE_SCENARIOS)[number];

export function isConsoleScenario(name: string): name is ConsoleScenario {
  return (CONSOLE_SCENARIOS as readonly string[]).includes(name);
}

/** Called once the SDK reaches `Launched`. */
export function runConsoleScenario(nonce: string): void {
  console.log(`BUGSEE_E2E console ${nonce}`);
  Bugsee.upload(`console-${nonce}`, '');
}
