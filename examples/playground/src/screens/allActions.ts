import type { Action } from '../ui/action';
import { captureActions } from './CaptureScreen';
import { dataActions } from './DataScreen';
import { errorsActions } from './ErrorsScreen';
import { homeActions } from './HomeScreen';
import { perfActions } from './PerfScreen';
import { privacyActions } from './PrivacyScreen';
import { reportsActions } from './ReportsScreen';

const byScreen: [string, Action[]][] = [
  ['home', homeActions],
  ['capture', captureActions],
  ['privacy', privacyActions],
  ['errors', errorsActions],
  ['reports', reportsActions],
  ['data', dataActions],
  ['perf', perfActions],
];

/** Every action on every tab screen, tagged with its screen. Used by the label-to-call mapping test. */
export const ALL_ACTIONS: { screen: string; action: Action }[] = byScreen.flatMap(([screen, list]) =>
  list.map((action) => ({ screen, action })),
);
