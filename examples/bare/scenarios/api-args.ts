/**
 * Overload and argument completeness (N-08): each public call with the
 * arguments the existing suites never pass. Every result is a marker; the
 * e2e (e2e/api-arguments.test.ts) reads the markers and the bundles.
 *
 *   api-token        before launch(): launch('') / '   ' / 42 must reject
 *                    without starting anything; then the app launches.
 *   api-subs         remove() on onLifecycleEvent and onStatusChange.
 *   api-exc-values   logException(string | plain object | null) and
 *                    {includeVideo: true | false}.
 *   api-notify       notify() with severity, fields and urgent, and bare.
 *   api-spans        every SpanStatus through finish(status), startChildSpan,
 *                    setStatus then finish(), a dead handle, startSpan with no
 *                    transaction, typed span attributes.
 *   api-data         log() default level, event() bare and with a bad name,
 *                    attribute bad arguments.
 *   api-filters      a throwing network filter, null/undefined clears, a log
 *                    filter cleared, a breadcrumb at every BreadcrumbLevel.
 *   api-handler-null setReportHandler(handler) then setReportHandler(null).
 *   api-report-members  a handler calling every BugseeReport member the
 *                    report-handler scenarios do not.
 *   api-delete-false upload, stop(), deleteCollectedDataOnDevice(false).
 *
 * `api-boundary` and `api-secure-off` render (scenarios/api.tsx).
 */
import Bugsee, {
  type BreadcrumbLevel,
  type BugseeReport,
  IssueSeverity,
  LogLevel,
  SpanStatus,
} from '@bugsee/react-native';

import { delay, mark, settle } from './api-common';
import { deadEndpointUrl } from '../endpoint';

/** Every `BreadcrumbLevel`, in the order breadcrumbs/types.ts lists them. */
export const BREADCRUMB_LEVELS_FOR_E2E: readonly BreadcrumbLevel[] = ['debug', 'info', 'warning', 'error', 'fatal'];

export const ARGS_SCENARIOS = [
  'api-token',
  'api-subs',
  'api-exc-values',
  'api-notify',
  'api-spans',
  'api-data',
  'api-filters',
  'api-handler-null',
  'api-report-members',
  'api-delete-false',
] as const;

export async function preLaunchArgs(scenario: string, nonce: string): Promise<void> {
  if (scenario === 'api-token') {
    const blank = await settle(() => Bugsee.launch(''));
    const spaces = await settle(() => Bugsee.launch('   '));
    const number = await settle(() => Bugsee.launch(42 as unknown as string));
    const status = await Bugsee.getStatus();
    mark(`token rejected nonce=${nonce} status=${status} blank=${blank} spaces=${spaces} number=${number}`);
  }
  if (scenario === 'api-report-members') {
    installMembersHandler(nonce);
  }
  if (scenario === 'api-handler-null') {
    Bugsee.setReportHandler({
      onAfterReportCreated: async report => {
        await report.setSummary(`edited-${nonce}`);
      },
    });
  }
}

export async function runArgsScenario(scenario: string, nonce: string): Promise<void> {
  switch (scenario) {
    case 'api-token':
      mark(`token launched nonce=${nonce} status=${await Bugsee.getStatus()}`);
      return;
    case 'api-subs':
      return subscriptions(nonce);
    case 'api-exc-values':
      return exceptionValues(nonce);
    case 'api-notify':
      return notifications(nonce);
    case 'api-spans':
      return spans(nonce);
    case 'api-data':
      return data(nonce);
    case 'api-filters':
      return filters(nonce);
    case 'api-handler-null':
      return handlerNull(nonce);
    case 'api-report-members':
      Bugsee.upload(`api-members-${nonce}`, '');
      mark(`members uploaded nonce=${nonce}`);
      return;
    case 'api-delete-false':
      return deleteFalse(nonce);
  }
}

async function subscriptions(nonce: string): Promise<void> {
  const kept: string[] = [];
  const keptStatus: number[] = [];
  let removedEvents = 0;
  let removedStatus = 0;
  const keep = Bugsee.onLifecycleEvent(event => kept.push(event.name));
  const keepStatus = Bugsee.onStatusChange(status => keptStatus.push(status));
  const events = Bugsee.onLifecycleEvent(() => {
    removedEvents += 1;
  });
  const statuses = Bugsee.onStatusChange(() => {
    removedStatus += 1;
  });
  events.remove();
  statuses.remove();
  // A second remove() must be harmless.
  const twice = await settle(() => events.remove());
  Bugsee.startBlackout();
  await delay(1_500);
  Bugsee.endBlackout();
  Bugsee.upload(`api-subs-${nonce}`, '');
  await delay(8_000);
  await Bugsee.stop();
  await delay(3_000);
  mark(
    `subs summary nonce=${nonce} kept=${JSON.stringify(kept)} keptStatus=${JSON.stringify(keptStatus)} ` +
      `removedEvents=${removedEvents} removedStatus=${removedStatus} removeTwice=${twice}`,
  );
  keep.remove();
  keepStatus.remove();
}

async function exceptionValues(nonce: string): Promise<void> {
  const results = {
    string: await settle(() => Bugsee.logException(`api-exc string ${nonce}`)),
    object: await settle(() => Bugsee.logException({ kind: 'plain', nonce })),
    null: await settle(() => Bugsee.logException(null)),
  };
  await delay(1_500);
  const video = {
    on: await settle(() => Bugsee.logException(new Error(`api-exc video-on ${nonce}`), { includeVideo: true })),
    off: await settle(() => Bugsee.logException(new Error(`api-exc video-off ${nonce}`), { includeVideo: false })),
  };
  mark(`exc-values done nonce=${nonce} results=${JSON.stringify(results)} video=${JSON.stringify(video)}`);
}

async function notifications(nonce: string): Promise<void> {
  const full = await settle(() =>
    Bugsee.notify(`api-notify-full-${nonce}`, `api-body-${nonce}`, IssueSeverity.Critical, { field: `fv-${nonce}` }, true),
  );
  const bare = await settle(() => Bugsee.notify(`api-notify-bare-${nonce}`));
  const sixth = await settle(() =>
    (Bugsee.notify as unknown as (...args: unknown[]) => void)(`api-notify-six-${nonce}`, '', 1, null, false, 'extra'),
  );
  mark(`notify sent nonce=${nonce} full=${full} bare=${bare} sixth=${sixth}`);
}

async function spans(nonce: string): Promise<void> {
  // No transaction yet on this thread: a no-op span, which must not throw.
  const orphan = await settle(() => {
    const span = Bugsee.startSpan('api.orphan', `orphan-${nonce}`);
    span.finish();
    return Bugsee.getActiveSpan() === null ? 'active=null' : 'active=span';
  });
  const transaction = Bugsee.startTransaction(`api-txn-${nonce}`, 'api.flow');
  transaction.setAttribute('s', `str-${nonce}`);
  transaction.setAttribute('n', 42);
  transaction.setAttribute('b', true);
  const statuses = Object.entries(SpanStatus);
  for (const [name, value] of statuses) {
    const span = Bugsee.startSpan('api.status', `status-${name}-${nonce}`);
    span.finish(value);
  }
  const child = transaction.startChildSpan('api.child', `child-${nonce}`);
  child.finish();
  const statusThenFinish = Bugsee.startSpan('api.set-status', `set-status-${nonce}`);
  statusThenFinish.setStatus(SpanStatus.Timeout);
  statusThenFinish.finish();
  const dead = Bugsee.startSpan('api.dead', `dead-${nonce}`);
  dead.finish();
  const afterFinish = await settle(() => dead.setDescription('after finish'));
  const finishTwice = await settle(() => dead.finish());
  transaction.finish(SpanStatus.OK);
  mark(
    `spans done nonce=${nonce} orphan=${orphan} afterFinish=${afterFinish} finishTwice=${finishTwice} ` +
      `statuses=${JSON.stringify(Object.fromEntries(statuses))}`,
  );
  Bugsee.upload(`api-spans-${nonce}`, '');
  mark(`spans uploaded nonce=${nonce}`);
}

async function data(nonce: string): Promise<void> {
  Bugsee.log(`api-log default ${nonce}`);
  Bugsee.log(`api-log verbose ${nonce}`, LogLevel.Verbose);
  const bare = await settle(() => Bugsee.event(`api-event-bare-${nonce}`));
  const badName = await settle(() => Bugsee.event(''));
  const badParams = await settle(() => Bugsee.event(`api-event-bad-${nonce}`, 'x' as unknown as Record<string, never>));
  const attrBadName = await settle(() => Bugsee.setAttribute('', 1));
  const attrBadValue = await settle(() => Bugsee.setAttribute(`api-attr-${nonce}`, { nested: true } as unknown as string));
  const attrHuge = await settle(() => Bugsee.setAttribute(`api-attr-huge-${nonce}`, 'x'.repeat(2 * 1024 * 1024)));
  mark(
    `data done nonce=${nonce} bare=${bare} badName=${badName} badParams=${badParams} ` +
      `attrBadName=${attrBadName} attrBadValue=${attrBadValue} attrHuge=${attrHuge}`,
  );
  await delay(1_000);
  Bugsee.upload(`api-data-${nonce}`, '');
  mark(`data uploaded nonce=${nonce}`);
}

async function fetchQuietly(url: string): Promise<void> {
  try {
    await fetch(url);
  } catch {
    // The endpoint is closed; the capture records the attempt.
  }
}

async function filters(nonce: string): Promise<void> {
  Bugsee.setNetworkFilter(event => {
    if ((event.url ?? '').includes(`net-throw-${nonce}`)) {
      throw new Error('api filter throws');
    }
    return event;
  });
  await fetchQuietly(deadEndpointUrl(`net-throw-${nonce}`));
  await delay(1_000);
  Bugsee.setNetworkFilter(() => null);
  await fetchQuietly(deadEndpointUrl(`net-dropped-${nonce}`));
  await delay(1_000);
  Bugsee.setNetworkFilter(null);
  await fetchQuietly(deadEndpointUrl(`net-null-${nonce}`));
  Bugsee.setNetworkFilter(() => null);
  Bugsee.setNetworkFilter(undefined);
  await fetchQuietly(deadEndpointUrl(`net-undefined-${nonce}`));
  Bugsee.setNetworkFilter();
  await fetchQuietly(deadEndpointUrl(`net-noarg-${nonce}`));

  Bugsee.setLogFilter(line => (line.includes(nonce) ? null : line));
  Bugsee.log(`api-log filtered ${nonce}`);
  await delay(1_000);
  Bugsee.setLogFilter(null);
  Bugsee.log(`api-log cleared ${nonce}`);

  for (const level of BREADCRUMB_LEVELS_FOR_E2E) {
    Bugsee.addBreadcrumb({ category: 'api', level, message: `api-crumb ${level} ${nonce}`, type: 'user' });
  }
  await delay(2_000);
  mark(`filters done nonce=${nonce} levels=${JSON.stringify(BREADCRUMB_LEVELS_FOR_E2E)}`);
  Bugsee.upload(`api-filters-${nonce}`, '');
  mark(`filters uploaded nonce=${nonce}`);
}

async function handlerNull(nonce: string): Promise<void> {
  Bugsee.setReportHandler(null);
  Bugsee.upload(`api-hnull-${nonce}`, '');
  mark(`hnull uploaded nonce=${nonce}`);
}

function installMembersHandler(nonce: string): void {
  Bugsee.setReportHandler({
    onAfterReportCreated: async (report: BugseeReport) => {
      const seen: Record<string, string> = {};
      const call = async (name: string, fn: () => Promise<unknown>) => {
        seen[name] = await settle(fn);
      };
      await call('getSummary', () => report.getSummary());
      await call('getDescription', () => report.getDescription());
      await call('getSeverity', () => report.getSeverity());
      await call('getLabels', () => report.getLabels());
      await call('setAttribute', () => report.setAttribute(`pre-${nonce}`, 'p'));
      await call('getAttributes', () => report.getAttributes());
      await call('clearAttributes', () => report.clearAttributes());
      await call('getAttributesCleared', () => report.getAttributes());
      await call('getScreenshotDisplayIds', () => report.getScreenshotDisplayIds());
      await call('getAttachmentNames', () => report.getAttachmentNames());
      await call('setAttributeAgain', () => report.setAttribute(`gone-${nonce}`, 'g'));
      await call('update', () =>
        report.update({
          summary: `upd-summary-${nonce}`,
          description: `upd-description-${nonce}`,
          severity: IssueSeverity.High,
          labels: [`upd-label-${nonce}`],
          clearAttributes: true,
          attributes: { [`upd-${nonce}`]: 'u', [`num-${nonce}`]: 7 },
        }),
      );
      await call('read', () => report.read());
      mark(`members seen nonce=${nonce} id=${report.id} type=${report.type} calls=${JSON.stringify(seen)}`);
    },
  });
}

async function deleteFalse(nonce: string): Promise<void> {
  Bugsee.upload(`api-delete-${nonce}`, '');
  await delay(10_000);
  mark(`delete uploaded nonce=${nonce}`);
  // The e2e lists the retained bundle and the capture parts in this window.
  await delay(10_000);
  const stopped = await settle(() => Bugsee.stop());
  const deleted = await settle(() => Bugsee.deleteCollectedDataOnDevice(false));
  mark(`delete done nonce=${nonce} stopped=${stopped} deleted=${deleted}`);
}
