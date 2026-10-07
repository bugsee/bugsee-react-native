/**
 * The STAGING lane's scenarios (plan N-19, section 1.10), driven by
 * e2e/staging.test.ts. Every report and crash carries `campaign <nonce>` so
 * the controller finds it on staging (through the staging Bugsee MCP) without
 * guessing. The same scenarios run offline against the dead endpoint as the
 * suite's dry run: everything up to the upload, which then fails.
 *
 *   stg-js-fatal         S-1/S-2: a JS fatal (`campaign <n> js fatal`).
 *   stg-js-handled       S-1/S-2: `logException` of a thrown Error, uploaded
 *                        at once.
 *   stg-native-segv      S-3 (Android NDK) / S-5 (iOS): `crashNative('segv')`,
 *                        after setting the attribute `campaign` to
 *                        `campaign <nonce> native segv` (the recovered report
 *                        carries it: a native crash has no JS text to search).
 *   stg-native-exception S-4 (Android Java) / S-5 (iOS NSException):
 *                        `testNativeCrash()`, attribute as above.
 *   stg-observe          the relaunch after a crash: the recovered report's
 *                        creation and its upload outcome are marked.
 *   stg-upload           S-6 acceptance: attributes, user id, a console line,
 *                        a fetch, an event, a trace, then `upload()` with a
 *                        severity and labels.
 *   stg-offline-upload   S-7: one `upload()`; its outcome events are marked
 *                        for three minutes while the e2e takes the network
 *                        away and gives it back.
 *   stg-feedback-chat    M-C1 / FLOW-50: the feedback chat with a listener;
 *                        after the first received batch the listener is
 *                        cleared (FB-03c).
 *
 * Every lifecycle event is marked `BUGSEE_E2E stg event name=<n> id=<id>
 * nonce=<n>` (subscribed before launch), so the e2e sees the upload
 * outcome of each report: BeforeReportUploaded, AfterReportUploaded,
 * ReportUploadFailed, ReportUploadFailedWithFutureRetry.
 */
import Bugsee, { IssueSeverity, type LifecycleEvent } from '@bugsee/react-native';
import { setListener, showFeedbackUI } from '@bugsee/react-native-feedback';
import { crashNative } from 'bugsee-e2e-native';

import { deadEndpointUrl } from '../endpoint';

export const STAGING_SCENARIOS = [
  'stg-js-fatal',
  'stg-js-handled',
  'stg-native-segv',
  'stg-native-exception',
  'stg-observe',
  'stg-upload',
  'stg-offline-upload',
  'stg-feedback-chat',
] as const;

export type StagingScenario = (typeof STAGING_SCENARIOS)[number];

export function isStagingScenario(name: string): name is StagingScenario {
  return (STAGING_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E stg ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** What the controller searches staging for. */
export function campaignText(nonce: string, what: string): string {
  return `campaign ${nonce} ${what}`;
}

/** The debug ids the release bundle registered (bugsee-cli inject), for `get_symbol_by_uuid`. */
function debugIds(): string[] {
  const ids = (globalThis as { _bugseeDebugIds?: Record<string, string> })._bugseeDebugIds;
  return ids === undefined ? [] : [...new Set(Object.values(ids))];
}

export function preLaunchStaging(scenario: StagingScenario, nonce: string): void {
  Bugsee.onLifecycleEvent((event: LifecycleEvent) => {
    mark(`event name=${event.name} id=${event.reportId ?? '-'} nonce=${nonce}`);
  });
  if (scenario === 'stg-observe') {
    Bugsee.setReportHandler({
      onBeforeReportCreated: report => {
        mark(`recovered before type=${report.type} id=${report.id} nonce=${nonce}`);
      },
      onAfterReportCreated: report => {
        mark(`recovered after type=${report.type} id=${report.id} nonce=${nonce}`);
      },
    });
  }
}

/** A thrown Error, so the stack has real frames in this bundle to symbolicate. */
export function stagingThrowSite(nonce: string, what: string): never {
  throw new Error(campaignText(nonce, what));
}

async function runUpload(nonce: string): Promise<void> {
  await Bugsee.setAttribute('campaign_nonce', nonce);
  Bugsee.setUserIdentifier(`campaign-${nonce}@example.com`);
  console.log(campaignText(nonce, 'console line'));
  Bugsee.log(campaignText(nonce, 'bugsee log'));
  Bugsee.event('campaign_event', { nonce });
  Bugsee.trace('campaign_trace', 42);
  try {
    await fetch(deadEndpointUrl(`campaign-fetch/${nonce}`));
  } catch {
    // The request is the point, not its answer.
  }
  await sleep(2_000);
  Bugsee.upload(campaignText(nonce, 'upload'), campaignText(nonce, 'description'), IssueSeverity.High, [
    'campaign',
    `nonce-${nonce}`,
  ]);
  mark(`uploaded summary="${campaignText(nonce, 'upload')}" nonce=${nonce}`);
}

function runFeedback(nonce: string): void {
  Bugsee.setUserIdentifier(`campaign-${nonce}@example.com`);
  setListener({
    onNewMessageSent(message) {
      mark(`feedback sent message=${JSON.stringify(message)} nonce=${nonce}`);
    },
    onNewMessagesReceived(messages) {
      mark(`feedback received count=${messages.length} nonce=${nonce}`);
      setListener(null);
      mark(`feedback listener-cleared nonce=${nonce}`);
    },
  });
  showFeedbackUI();
  mark(`feedback shown nonce=${nonce}`);
}

/** What the scenario does once the SDK is Launched. */
export async function runStagingScenario(scenario: StagingScenario, nonce: string): Promise<void> {
  mark(`launched scenario=${scenario} debug-ids=${JSON.stringify(debugIds())} nonce=${nonce}`);
  switch (scenario) {
    case 'stg-js-fatal':
      mark(`crashing kind=js-fatal text="${campaignText(nonce, 'js fatal')}" nonce=${nonce}`);
      setTimeout(() => stagingThrowSite(nonce, 'js fatal'), 0);
      return;
    case 'stg-js-handled':
      try {
        stagingThrowSite(nonce, 'js handled');
      } catch (error) {
        Bugsee.logException(error, { labels: ['campaign', `nonce-${nonce}`] });
      }
      mark(`handled-sent text="${campaignText(nonce, 'js handled')}" nonce=${nonce}`);
      return;
    case 'stg-native-segv':
      // A native crash carries no JS text: the attribute is what makes the
      // recovered report findable by `campaign <nonce>` on staging.
      await Bugsee.setAttribute('campaign', campaignText(nonce, 'native segv'));
      mark(`crashing kind=segv nonce=${nonce}`);
      await sleep(500);
      crashNative('segv');
      return;
    case 'stg-native-exception':
      await Bugsee.setAttribute('campaign', campaignText(nonce, 'native exception'));
      mark(`crashing kind=native-exception nonce=${nonce}`);
      await sleep(500);
      Bugsee.testNativeCrash();
      return;
    case 'stg-observe':
      // The recovery and its upload happen on their own; the e2e waits on the
      // event marks.
      return;
    case 'stg-upload':
      await runUpload(nonce);
      return;
    case 'stg-offline-upload':
      Bugsee.upload(campaignText(nonce, 'offline upload'), '', IssueSeverity.Medium, ['campaign', `nonce-${nonce}`]);
      mark(`uploaded summary="${campaignText(nonce, 'offline upload')}" nonce=${nonce}`);
      return;
    case 'stg-feedback-chat':
      runFeedback(nonce);
      return;
  }
}
