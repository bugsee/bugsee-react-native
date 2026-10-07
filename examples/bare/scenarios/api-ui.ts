/**
 * Screen-facing API scenarios: console levels (N-05), SDK breadcrumbs and a
 * plain upload's video (N-11), the report dialog's 14 colour keys (N-13), and
 * the feedback package's 28 keys, greeting, listener and pre-launch use
 * (N-14). The secure-rectangle stage (N-04) renders in scenarios/api.tsx.
 *
 *   api-console-levels  console.error/warn/log/info/debug, then an RCTLog
 *                       warning with no console call behind it (the
 *                       native-only stream), each counted by a log filter.
 *   api-sdk-crumbs      breadcrumbs on; a white screen for a few seconds, the
 *                       e2e backgrounds and foregrounds the app, one upload.
 *   api-dialog-keys     every report key set to its own colour, read back,
 *                       the foreign keys tried, then the dialog.
 *   api-feedback-keys   every feedback key likewise, then the chat (an
 *                       e-mail user id skips the e-mail screen).
 *   api-feedback-email  the same keys, no user id, the chat (the e2e clears
 *                       the app's data first, so the e-mail screen shows).
 *   api-feedback-null   setGreeting then setGreeting(null), a listener then
 *                       setListener(null) twice, then the chat.
 *   api-feedback-prelaunch  setGreeting, a colour, setListener and
 *                       showFeedbackUI before launch().
 */
import Bugsee from '@bugsee/react-native';
import { appearance as feedbackAppearance, setGreeting, setListener, showFeedbackUI } from '@bugsee/react-native-feedback';
import { rctLog } from 'bugsee-e2e-native';

import { delay, mark, settle } from './api-common';
import { FEEDBACK_COLOURS, REPORT_COLOURS } from './api-constants';

export const UI_SCENARIOS = [
  'api-console-levels',
  'api-sdk-crumbs',
  'api-dialog-keys',
  'api-feedback-keys',
  'api-feedback-email',
  'api-feedback-null',
  'api-feedback-prelaunch',
] as const;

export function uiLaunchOverrides(scenario: string, apply: (key: string, value: unknown) => void): void {
  if (scenario === 'api-sdk-crumbs') {
    apply('com.bugsee.option.capture.breadcrumbs', true);
  }
}

export async function preLaunchUi(scenario: string, nonce: string): Promise<void> {
  if (scenario !== 'api-feedback-prelaunch') {
    return;
  }
  const calls = {
    greeting: await settle(() => setGreeting(`hello-pre ${nonce}`)),
    colour: await settle(() => {
      feedbackAppearance.backgroundColor = '#112233';
    }),
    listener: await settle(() => setListener({ onNewMessageSent: () => {} })),
    show: await settle(() => showFeedbackUI()),
  };
  mark(`feedback prelaunch nonce=${nonce} status=${await Bugsee.getStatus()} calls=${JSON.stringify(calls)}`);
}

export async function runUiScenario(scenario: string, nonce: string): Promise<void> {
  switch (scenario) {
    case 'api-console-levels':
      return consoleLevels(nonce);
    case 'api-sdk-crumbs':
      return sdkCrumbs(nonce);
    case 'api-dialog-keys':
      return dialogKeys(nonce);
    case 'api-feedback-keys':
      Bugsee.setUserIdentifier(`e2e-${nonce}@example.com`);
      paintFeedback(nonce);
      showFeedbackUI();
      mark(`feedback shown nonce=${nonce}`);
      return;
    case 'api-feedback-email':
      Bugsee.clearUserIdentifier();
      paintFeedback(nonce);
      showFeedbackUI();
      mark(`feedback shown nonce=${nonce}`);
      return;
    case 'api-feedback-null':
      return feedbackNull(nonce);
    case 'api-feedback-prelaunch':
      mark(`feedback prelaunch launched nonce=${nonce} status=${await Bugsee.getStatus()}`);
      return;
  }
}

async function consoleLevels(nonce: string): Promise<void> {
  const counts: Record<string, number> = {};
  Bugsee.setLogFilter(line => {
    const found = /api-lvl (\w+) /.exec(line);
    if (found !== null && line.includes(nonce)) {
      counts[found[1]!] = (counts[found[1]!] ?? 0) + 1;
    }
    return line;
  });
  console.error(`api-lvl error ${nonce}`);
  console.warn(`api-lvl warn ${nonce}`);
  console.log(`api-lvl log ${nonce}`);
  console.info(`api-lvl info ${nonce}`);
  console.debug(`api-lvl debug ${nonce}`);
  // No console call behind it: the native RCTLog stream on its own.
  rctLog('warn', `api-lvl rct ${nonce}`);
  await delay(3_000);
  mark(`levels counts nonce=${nonce} counts=${JSON.stringify(counts)}`);
  Bugsee.upload(`api-levels-${nonce}`, '');
  mark(`levels uploaded nonce=${nonce}`);
}

function sdkCrumbs(nonce: string): void {
  Bugsee.addBreadcrumb({ category: 'api', level: 'info', message: `api-own-crumb ${nonce}`, type: 'user' });
  mark(`crumbs ready nonce=${nonce}`);
  // The e2e backgrounds and foregrounds the app, then waits for this upload.
  setTimeout(() => {
    Bugsee.upload(`api-crumbs-${nonce}`, '');
    mark(`crumbs uploaded nonce=${nonce}`);
  }, 20_000);
}

function paintReport(): { readback: Record<string, string | null>; foreign: Record<string, string> } {
  const readback: Record<string, string | null> = {};
  const foreign: Record<string, string> = {};
  const surface = Bugsee.appearance as unknown as Record<string, string | undefined>;
  for (const [key, colour] of Object.entries(REPORT_COLOURS)) {
    try {
      surface[key] = colour;
      readback[key] = surface[key] ?? null;
    } catch (error) {
      foreign[key] = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      readback[key] = surface[key] ?? null;
    }
  }
  return { readback, foreign };
}

async function dialogKeys(nonce: string): Promise<void> {
  const { readback, foreign } = paintReport();
  mark(`dialog-keys readback nonce=${nonce} values=${JSON.stringify(readback)}`);
  mark(`dialog-keys foreign nonce=${nonce} values=${JSON.stringify(foreign)}`);
  // Filled fields, so textColor has text to paint; hints show where empty.
  Bugsee.showReportDialog(`api-dialog-${nonce}`, `api-description ${nonce}`);
  mark(`dialog-keys shown nonce=${nonce}`);
}

function paintFeedback(nonce: string): void {
  const readback: Record<string, string | null> = {};
  const foreign: Record<string, string> = {};
  const surface = feedbackAppearance as unknown as Record<string, string | undefined>;
  for (const [key, colour] of Object.entries(FEEDBACK_COLOURS)) {
    try {
      surface[key] = colour;
      readback[key] = surface[key] ?? null;
    } catch (error) {
      foreign[key] = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      readback[key] = surface[key] ?? null;
    }
  }
  mark(`feedback-keys readback nonce=${nonce} values=${JSON.stringify(readback)}`);
  mark(`feedback-keys foreign nonce=${nonce} values=${JSON.stringify(foreign)}`);
}

async function feedbackNull(nonce: string): Promise<void> {
  Bugsee.setUserIdentifier(`e2e-${nonce}@example.com`);
  const calls = {
    greeting: await settle(() => setGreeting(`hello-gone ${nonce}`)),
    greetingNull: await settle(() => setGreeting(null)),
    listener: await settle(() => setListener({ onNewMessagesReceived: () => {} })),
    listenerNull: await settle(() => setListener(null)),
    listenerNullAgain: await settle(() => setListener(null)),
  };
  showFeedbackUI();
  mark(`feedback null nonce=${nonce} calls=${JSON.stringify(calls)}`);
  mark(`feedback shown nonce=${nonce}`);
}
