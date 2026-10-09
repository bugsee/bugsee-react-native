/**
 * N-08: every public overload and argument the other suites never pass
 * (the API rows marked N-08 in section 1.1). Scenarios in
 * scenarios/api-args.ts and, for the rendering ones, scenarios/api.tsx.
 *
 * The iOS simulator slice compiles logException out (exceptions.test.ts), so
 * the cases that need an error report are A and X only there.
 */
import { type PulledBundle, captureEvents, crashOf, relayTexts } from './bundles';
import { type Settled, apiMarker, jsonAfter, wordAfter } from './api-markers';
import { iosTarget } from './device';
import {
  IOS_SDK_LINE,
  ON_ANDROID,
  ON_IOS,
  type Run,
  TARGET_NAME,
  awaitBundles,
  clearBundles,
  describeDevice,
  listBundles,
  report,
  startRun,
  stopApp,
} from './harness';
import { LUMA_BRIGHT_MIN, LUMA_DARK_MAX, imageSize, regionLuma } from './media';
import { beginRetainingSuite, captureGenerationFiles, endRetainingSuite } from './observe';
import { type DeviceLog, type LogLine } from './scenario';
import { type Rect, markerRect, markerScreen, regionOnImage } from './screen';

jest.setTimeout(6 * 60_000);

const ON_SIMULATOR = ON_IOS && iosTarget() === 'simulator';
/** Needs an error report: the simulator slice has no exception reporter. */
const itReports = ON_SIMULATOR ? it.skip : it;

function bySummary(bundles: readonly PulledBundle[], summary: string): PulledBundle {
  const found = bundles.filter(b => b.request.summary === summary);
  if (found.length !== 1) {
    throw new Error(`expected one bundle ${summary}, got ${JSON.stringify(bundles.map(b => b.request.summary))}`);
  }
  return found[0]!;
}

function types(bundle: PulledBundle): string[] {
  return bundle.manifest.files.map(file => file.type).sort();
}

/** The error report's exception `reason` text. */
function reasonOf(bundle: PulledBundle): string {
  const crash = crashOf(bundle);
  const exception = (crash?.exception ?? {}) as { reason?: unknown };
  return String(exception.reason ?? '');
}

/** The JS payload's `reason` (exception.reason is the payload as JSON text). */
function payloadReason(bundle: PulledBundle): string {
  const text = reasonOf(bundle);
  try {
    return String((JSON.parse(text) as { reason?: unknown }).reason ?? '');
  } catch {
    return text;
  }
}

/** Runs `scenario`, waits for `marker`, then for `count` bundles. */
async function runFor(
  log: DeviceLog,
  scenario: string,
  marker: string,
  count: number,
  timeoutMs = 45_000,
): Promise<{ run: Run; line: LogLine; bundles: PulledBundle[] }> {
  await clearBundles();
  const run = await startRun(scenario);
  const line = await apiMarker(log, marker, run.scenario.nonce, timeoutMs, run.start);
  const bundles = count > 0 ? await awaitBundles(count, 60_000) : [];
  report(`${scenario} ${marker}`, line.text.trim());
  report(`${scenario} bundles`, bundles.map(b => ({ summary: b.request.summary, type: b.request.type, files: types(b) })));
  return { run, line, bundles };
}

describeDevice(`overloads and arguments on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await beginRetainingSuite('N-08');
  });

  afterAll(() => endRetainingSuite(log));

  describe('launch() with a blank or non-string token', () => {
    let run: Run;
    let rejected: LogLine;

    beforeAll(async () => {
      run = await startRun('api-token');
      rejected = await apiMarker(log!, 'token rejected', run.scenario.nonce, 20_000, run.start);
      report('rejected', rejected.text.trim());
      await stopApp();
    });

    it('[API-01c] rejects before the bridge, and nothing starts', () => {
      for (const key of ['blank', 'spaces', 'number']) {
        const settled = jsonAfter<Settled>(rejected.text, key);
        expect({ key, ok: settled.ok, message: settled.error?.message }).toEqual({
          key,
          ok: false,
          message: 'Bugsee.launch requires a non-empty app token',
        });
      }
      expect(wordAfter(rejected.text, 'status')).toBe('0');
      // The SDK printed nothing before the app's own launch: the banner follows the rejections.
      const banner = log!.all(ON_IOS ? IOS_SDK_LINE : /Bugsee Android SDK \S+ \[[0-9a-f]+\]/, run.start);
      expect(banner.length).toBeGreaterThan(0);
      expect(banner[0]!.index).toBeGreaterThan(rejected.index);
    });

    /**
     * The implementation plan (docs/design/plans/2026-09-16-implementation-plan.md,
     * Phase 1 Red) says a blank token rejects with `E_TOKEN`. `assertUsableToken`
     * (packages/react-native/src/index.ts) throws a plain Error with no `code`.
     * Wrapper divergence, to fix (sdk-issues-filed.md "to fix").
     */
    it.failing('[API-01c] the rejection carries code E_TOKEN', () => {
      for (const key of ['blank', 'spaces', 'number']) {
        expect(jsonAfter<Settled>(rejected.text, key).error?.code).toBe('E_TOKEN');
      }
    });
  });

  it('[API-05][API-06] remove() stops delivery on both subscriptions; a second remove() is harmless', async () => {
    const { line } = await runFor(log!, 'api-subs', 'subs summary', 0, 60_000);
    await stopApp();
    expect(wordAfter(line.text, 'removedEvents')).toBe('0');
    expect(wordAfter(line.text, 'removedStatus')).toBe('0');
    expect(jsonAfter<Settled>(line.text, 'removeTwice').ok).toBe(true);
    const kept = jsonAfter<string[]>(line.text, 'kept');
    expect(kept).toEqual(expect.arrayContaining(['BlackoutStarted', 'BlackoutEnded', 'BeforeReportAssembled', 'AfterReportAssembled', 'Stopping', 'Stopped']));
    expect(jsonAfter<number[]>(line.text, 'keptStatus')).toEqual([3, 0]);
  });

  describe('logException with values that are not Errors, and includeVideo', () => {
    let run: Run;
    let done: LogLine;
    let errors: PulledBundle[] = [];

    beforeAll(async () => {
      if (ON_SIMULATOR) {
        return;
      }
      const result = await runFor(log!, 'api-exc-values', 'exc-values done', 5);
      run = result.run;
      done = result.line;
      errors = result.bundles.filter(b => b.request.type === 'error');
      report('error reasons', errors.map(b => reasonOf(b).slice(0, 200)));
      await stopApp();
    });

    itReports('[API-11e] a string, a plain object and null each file one report, without throwing', () => {
      const nonce = run.scenario.nonce;
      const results = jsonAfter<Record<string, Settled>>(done.text, 'results');
      expect(Object.values(results).every(r => r.ok)).toBe(true);
      // payload.ts describeThrown (R9): a string is the reason; an object
      // with no string `message`, and null (typeof "object"), are
      // `Non-Error thrown: object`.
      const reasons = errors.map(b => payloadReason(b));
      report('payload reasons', reasons);
      expect(reasons.filter(r => r === `api-exc string ${nonce}`)).toHaveLength(1);
      expect(reasons.filter(r => r === 'Non-Error thrown: object')).toHaveLength(2);
      // The three values plus the two includeVideo errors.
      expect(errors).toHaveLength(5);
    });

    itReports('[API-11d] includeVideo is accepted and changes nothing', () => {
      const nonce = run.scenario.nonce;
      const video = jsonAfter<Record<string, Settled>>(done.text, 'video');
      expect(video.on!.ok && video.off!.ok).toBe(true);
      const on = errors.find(b => payloadReason(b) === `api-exc video-on ${nonce}`);
      const off = errors.find(b => payloadReason(b) === `api-exc video-off ${nonce}`);
      expect(on).toBeDefined();
      expect(off).toBeDefined();
      report('includeVideo files', { on: types(on!), off: types(off!) });
      expect(types(on!)).toEqual(types(off!));
    });
  });

  describe('ErrorBoundary with a fallback function and options', () => {
    let run: Run;
    let fallback: LogLine;
    let bundles: PulledBundle[] = [];

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('api-boundary');
      fallback = await apiMarker(log!, 'boundary fallback', run.scenario.nonce, 30_000, run.start);
      await new Promise(resolve => setTimeout(resolve, 2_000));
      report('fallback', fallback.text.trim());
      if (!ON_SIMULATOR) {
        bundles = (await awaitBundles(1, 45_000)).filter(b => b.request.type === 'error');
        report('boundary errors', bundles.map(b => ({ reason: reasonOf(b).slice(0, 160), labels: b.request.labels, crash: crashOf(b) === undefined ? '-' : 'yes' })));
      }
      await stopApp();
    });

    it('[API-13b] the fallback function is called with the error and the component stack', () => {
      // React renders the fallback first from getDerivedStateFromError (no
      // stack yet), then again once componentDidCatch has stored the stack.
      const calls = log!.all(new RegExp(`BUGSEE_E2E api boundary fallback nonce=${run.scenario.nonce} `), run.start);
      report('fallback calls', calls.map(line => line.text.trim()));
      expect(calls.every(line => line.text.includes(`error=api-boundary render ${run.scenario.nonce}`))).toBe(true);
      expect(calls.some(line => wordAfter(line.text, 'stack') === 'has-thrower')).toBe(true);
      expect(fallback.text).toContain(`error=api-boundary render ${run.scenario.nonce}`);
      expect(log!.all(new RegExp(`BUGSEE_E2E api boundary onError nonce=${run.scenario.nonce}`), run.start)).toHaveLength(1);
    });

    itReports('[API-13d] the options prop: the domain reaches the report', () => {
      expect(bundles).toHaveLength(1);
      const crash = crashOf(bundles[0]!)!;
      if (ON_ANDROID) {
        expect((crash.exception as { domain?: unknown }).domain).toBe(`api-domain-${run.scenario.nonce}`);
      } else {
        expect((crash.exceptionLoggingOptions as { exceptionDomain?: unknown }).exceptionDomain).toBe(`api-domain-${run.scenario.nonce}`);
      }
    });

    /** Android 7.3.0 ignores logException labels (R10, exceptions.test.ts case 7): the same path. */
    (ON_ANDROID ? it.failing : itReports)('[API-13d] the options prop: labels reach the report', () => {
      expect(bundles).toHaveLength(1);
      expect(bundles[0]!.request.labels).toEqual(expect.arrayContaining([`api-label-${run.scenario.nonce}`]));
    });
  });

  it('[API-15b-d] notify() carries severity, fields and urgent into the relay record; a sixth argument throws', async () => {
    const { run, line } = await runFor(log!, 'api-notify', 'notify sent', 0);
    const nonce = run.scenario.nonce;
    expect(jsonAfter<Settled>(line.text, 'full').ok).toBe(true);
    expect(jsonAfter<Settled>(line.text, 'bare').ok).toBe(true);
    expect(jsonAfter<Settled>(line.text, 'sixth').error?.name).toBe('TypeError');
    let texts: string[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      texts = await relayTexts(ON_IOS);
      if (texts.some(t => t.includes(`api-notify-full-${nonce}`)) && texts.some(t => t.includes(`api-notify-bare-${nonce}`))) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await stopApp();
    const full = texts.filter(t => t.includes(`api-notify-full-${nonce}`));
    const bare = texts.filter(t => t.includes(`api-notify-bare-${nonce}`));
    report('relay full', full.map(t => t.slice(0, 600)));
    report('relay bare', bare.map(t => t.slice(0, 600)));
    expect(full).toHaveLength(1);
    expect(bare).toHaveLength(1);
    expect(full[0]).toContain(`api-body-${nonce}`);
    expect(full[0]).toContain(`fv-${nonce}`);
    expect(texts.some(t => t.includes(`api-notify-six-${nonce}`))).toBe(false);
  });

  describe('spans', () => {
    let run: Run;
    let done: LogLine;
    let capture: string;

    beforeAll(async () => {
      const result = await runFor(log!, 'api-spans', 'spans uploaded', 1);
      run = result.run;
      done = await apiMarker(log!, 'spans done', run.scenario.nonce, 1_000, run.start);
      capture = bySummary(result.bundles, `api-spans-${run.scenario.nonce}`).captures.get('performance') ?? '';
      report('performance capture (head)', capture.slice(0, 1500));
      await stopApp();
    });

    function span(description: string): Record<string, unknown> | undefined {
      let found: Record<string, unknown> | undefined;
      const walk = (node: unknown): void => {
        if (found !== undefined || node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        const record = node as Record<string, unknown>;
        if (record.description === description) {
          found = record;
          return;
        }
        Object.values(record).forEach(walk);
      };
      walk(JSON.parse(capture === '' ? '{}' : capture) as unknown);
      return found;
    }

    it('[API-17c] startSpan with no transaction is a no-op that does not throw', () => {
      expect(jsonAfter<Settled>(done.text, 'orphan')).toEqual({ ok: true, value: 'active=null' });
      expect(capture).not.toContain(`orphan-${run.scenario.nonce}`);
    });

    it('[API-19e] finish(status) records each SpanStatus', () => {
      const statuses = jsonAfter<Record<string, number>>(done.text, 'statuses');
      const seen = Object.fromEntries(
        Object.keys(statuses).map(name => [name, span(`status-${name}-${run.scenario.nonce}`)?.status ?? null]),
      );
      report('recorded statuses', seen);
      for (const name of Object.keys(statuses)) {
        expect({ name, recorded: seen[name] !== null }).toEqual({ name, recorded: true });
      }
      // Six different statuses recorded as six different values.
      expect(new Set(Object.values(seen).map(v => JSON.stringify(v))).size).toBe(Object.keys(statuses).length);
    });

    it('[API-19f] startChildSpan is a child of its span', () => {
      const child = span(`child-${run.scenario.nonce}`);
      // The transaction carries its name (not a description); its own span is
      // the root of its `spans` (no parentSpanId), as span-lifecycle.test.ts reads it.
      let transaction: { name?: unknown; spans?: Array<Record<string, unknown>> } | undefined;
      const walk = (node: unknown): void => {
        if (transaction !== undefined || node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        const record = node as { name?: unknown; spans?: Array<Record<string, unknown>> };
        if (record.name === `api-txn-${run.scenario.nonce}` && Array.isArray(record.spans)) {
          transaction = record;
          return;
        }
        Object.values(record).forEach(walk);
      };
      walk(JSON.parse(capture === '' ? '{}' : capture) as unknown);
      const root = transaction?.spans?.find(s => s.parentSpanId === undefined);
      report('child span', child);
      report('transaction root', { spanId: root?.spanId, childParent: child?.parentSpanId });
      expect(child).toBeDefined();
      expect(root?.spanId).toBeDefined();
      expect(child!.parentSpanId).toBe(root!.spanId);
    });

    it('[API-19d] setStatus then finish() with no argument ends OK, as documented (divergence 12)', () => {
      const recorded = span(`set-status-${run.scenario.nonce}`);
      report('setStatus+finish span', recorded);
      expect(recorded).toBeDefined();
      const timeout = span(`status-Timeout-${run.scenario.nonce}`)?.status;
      const ok = span(`status-OK-${run.scenario.nonce}`)?.status;
      report('setStatus(Timeout)+finish() recorded as', { recorded: recorded!.status, timeoutIs: timeout, okIs: ok });
      // beta-coverage-report.md item 12: a no-arg finish() is OK on both
      // SDKs, so setStatus alone never reaches a report.
      expect(ok).toBeDefined();
      expect(recorded!.status).toEqual(ok);
      expect(recorded!.status).not.toEqual(timeout);
    });

    it('[API-19g] a finished span rejects further use with E_SPAN_HANDLE_DEAD', () => {
      const after = jsonAfter<Settled>(done.text, 'afterFinish');
      expect(after.ok).toBe(false);
      expect(after.error?.code).toBe('E_SPAN_HANDLE_DEAD');
      expect(after.error?.name).toBe('BugseeSpanError');
    });

    it('[API-19c] span attributes keep string, number and boolean values', () => {
      const transaction = span(`api-txn-${run.scenario.nonce}`) ?? (JSON.parse(capture) as Record<string, unknown>);
      const text = JSON.stringify(transaction);
      expect(text).toContain(`str-${run.scenario.nonce}`);
      expect(text).toMatch(/"n":42\b/);
      expect(text).toMatch(/"b":true\b/);
    });
  });

  describe('log, event and attribute arguments', () => {
    let run: Run;
    let done: LogLine;
    let bundle: PulledBundle;

    beforeAll(async () => {
      const result = await runFor(log!, 'api-data', 'data uploaded', 1);
      run = result.run;
      done = await apiMarker(log!, 'data done', run.scenario.nonce, 1_000, run.start);
      bundle = bySummary(result.bundles, `api-data-${run.scenario.nonce}`);
      await stopApp();
    });

    it('[API-20a] log(message) with no level is Custom (98) at Info (3)', () => {
      const lines = captureEvents(bundle, 'log').filter(e => e.message === `api-log default ${run.scenario.nonce}`);
      expect(lines.map(e => ({ level: e.level, source: e.source }))).toEqual([{ level: 3, source: 98 }]);
    });

    it('[API-21] event(name) with no params reaches the report; a bad name or bad params throw', () => {
      expect(jsonAfter<Settled>(done.text, 'bare').ok).toBe(true);
      expect(jsonAfter<Settled>(done.text, 'badName').ok).toBe(false);
      expect(jsonAfter<Settled>(done.text, 'badParams').ok).toBe(false);
      expect(bundle.captures.get('events.user') ?? '').toContain(`api-event-bare-${run.scenario.nonce}`);
      expect(bundle.captures.get('events.user') ?? '').not.toContain(`api-event-bad-${run.scenario.nonce}`);
    });

    it('[API-23f] invalid attribute names and values reject with BugseeAttributeError codes', () => {
      const badName = jsonAfter<Settled>(done.text, 'attrBadName');
      const badValue = jsonAfter<Settled>(done.text, 'attrBadValue');
      const huge = jsonAfter<Settled>(done.text, 'attrHuge');
      report('attribute rejections', { badName, badValue, huge });
      expect(badName.error).toMatchObject({ name: 'BugseeAttributeError', code: 'E_ATTRIBUTE_BAD_ARGUMENT' });
      expect(badValue.error).toMatchObject({ name: 'BugseeAttributeError', code: 'E_ATTRIBUTE_BAD_ARGUMENT' });
      expect(huge.ok).toBe(false);
      expect(huge.error).toMatchObject({ name: 'BugseeAttributeError' });
      expect(['E_ATTRIBUTE_BAD_ARGUMENT', 'E_ATTRIBUTE_REJECTED']).toContain(huge.error?.code);
    });
  });

  describe('filters cleared and thrown from, and every breadcrumb level', () => {
    let run: Run;
    let bundle: PulledBundle;

    beforeAll(async () => {
      const result = await runFor(log!, 'api-filters', 'filters uploaded', 1, 60_000);
      run = result.run;
      bundle = bySummary(result.bundles, `api-filters-${run.scenario.nonce}`);
      await stopApp();
    });

    const urls = () => captureEvents(bundle, 'network').map(e => String(e.url ?? ''));
    const has = (part: string) => urls().some(url => url.includes(`${part}-${run.scenario.nonce}`));

    it('[API-25] a throwing network filter drops the event; null, undefined and no argument clear the filter', () => {
      report('network urls', urls().filter(u => u.includes(run.scenario.nonce)));
      expect(has('net-throw')).toBe(false);
      expect(has('net-dropped')).toBe(false);
      expect(has('net-null')).toBe(true);
      expect(has('net-undefined')).toBe(true);
      expect(has('net-noarg')).toBe(true);
    });

    it('[API-27] setLogFilter(null) clears the log filter', () => {
      const messages = captureEvents(bundle, 'log').map(e => String(e.message ?? ''));
      expect(messages).not.toContain(`api-log filtered ${run.scenario.nonce}`);
      expect(messages).toContain(`api-log cleared ${run.scenario.nonce}`);
    });

    it('[API-28] a breadcrumb at every BreadcrumbLevel is retained', () => {
      const crumbs = bundle.captures.get('breadcrumbs') ?? '';
      const found = ['debug', 'info', 'warning', 'error', 'fatal'].map(level => ({
        level,
        retained: crumbs.includes(`api-crumb ${level} ${run.scenario.nonce}`),
      }));
      report('breadcrumbs (head)', crumbs.slice(0, 1200));
      expect(found.every(f => f.retained)).toBe(true);
    });
  });

  it('[API-34b] setReportHandler(null) removes the handler: the next report is unedited', async () => {
    const { run, bundles } = await runFor(log!, 'api-handler-null', 'hnull uploaded', 1);
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await stopApp();
    expect(bundles.map(b => b.request.summary)).toEqual([`api-hnull-${run.scenario.nonce}`]);
  });

  describe('BugseeReport members the report-handler scenarios do not call', () => {
    let run: Run;
    let seen: LogLine;
    let bundle: PulledBundle;

    beforeAll(async () => {
      await clearBundles();
      run = await startRun('api-report-members');
      seen = await apiMarker(log!, 'members seen', run.scenario.nonce, 45_000, run.start);
      report('members', seen.text.trim());
      bundle = bySummary(await awaitBundles(1, 60_000), `upd-summary-${run.scenario.nonce}`);
      await stopApp();
    });

    it('[API-35] getters, attributes, display ids and attachment names answer', () => {
      const calls = jsonAfter<Record<string, Settled>>(seen.text, 'calls');
      for (const [name, settled] of Object.entries(calls)) {
        expect({ name, ok: settled.ok }).toEqual({ name, ok: true });
      }
      expect(calls.getSummary!.value).toBe(`api-members-${run.scenario.nonce}`);
      expect(calls.getAttributes!.value).toEqual(expect.objectContaining({ [`pre-${run.scenario.nonce}`]: 'p' }));
      expect(calls.getAttributesCleared!.value).toEqual({});
      expect(Array.isArray(calls.getScreenshotDisplayIds!.value)).toBe(true);
      expect(Array.isArray(calls.getAttachmentNames!.value)).toBe(true);
    });

    it('[API-35] update(patch) with clearAttributes reaches the bundle', () => {
      const nonce = run.scenario.nonce;
      expect(bundle.request.description).toBe(`upd-description-${nonce}`);
      expect(bundle.request.severity).toBe(3);
      expect(bundle.request.labels).toEqual([`upd-label-${nonce}`]);
      const attrs = bundle.manifest.attrs;
      report('attrs', attrs);
      expect(Object.keys(attrs)).not.toContain(`gone-${nonce}`);
      expect(Object.keys(attrs)).not.toContain(`pre-${nonce}`);
      expect(attrs[`upd-${nonce}`]).toBe('u');
      expect(attrs[`num-${nonce}`]).toBe(7);
    });
  });

  it('[API-41c] deleteCollectedDataOnDevice(false) after stop resolves and reports what it kept', async () => {
    await clearBundles();
    const run = await startRun('api-delete-false');
    const uploaded = await apiMarker(log!, 'delete uploaded', run.scenario.nonce, 30_000, run.start);
    const bundlesBefore = await listBundles();
    const partsBefore = await captureGenerationFiles();
    const done = await apiMarker(log!, 'delete done', run.scenario.nonce, 40_000, uploaded.index, run.start);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const bundlesAfter = await listBundles();
    const partsAfter = await captureGenerationFiles();
    await stopApp();
    report('delete(false)', { done: done.text.trim(), bundlesBefore, bundlesAfter, partsBefore: partsBefore.length, partsAfter: partsAfter.length });
    expect(jsonAfter<Settled>(done.text, 'stopped')).toEqual({ ok: true, value: true });
    expect(jsonAfter<Settled>(done.text, 'deleted')).toEqual({ ok: true, value: true });
    expect(bundlesBefore.length).toBe(1);
    // Documented semantics (index.ts): `false` keeps the rolling capture.
    expect(partsAfter.length).toBeGreaterThan(0);
  });

  it('[API-31] <BugseeSecure enabled={false}> is recorded in the clear, its enabled twin masked', async () => {
    const { run, bundles } = await runFor(log!, 'api-secure-off', 'secure-off uploaded', 1);
    await stopApp();
    const nonce = run.scenario.nonce;
    const on = log!.all(new RegExp(`BUGSEE_E2E api secure-off probe=on .*nonce=${nonce}`), run.start)[0]!;
    const off = log!.all(new RegExp(`BUGSEE_E2E api secure-off probe=off .*nonce=${nonce}`), run.start)[0]!;
    const bundle = bySummary(bundles, `api-secure-off-${nonce}`);
    const shot = (bundle.binaries.get('screenshot') ?? [])[0];
    expect(shot).toBeDefined();
    const screen = markerScreen(on);
    const size = await imageSize(shot!);
    const luma = (rect: Rect) => regionLuma(shot!, regionOnImage(rect, screen.width, size.width, 0.6));
    const lumas = { on: await luma(markerRect(on)), off: await luma(markerRect(off)) };
    report('screenshot lumas', lumas);
    expect(lumas.on).toBeLessThanOrEqual(LUMA_DARK_MAX);
    expect(lumas.off).toBeGreaterThanOrEqual(LUMA_BRIGHT_MIN);
  });
});
