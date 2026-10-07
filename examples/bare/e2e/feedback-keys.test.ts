/**
 * N-14: the feedback package beyond feedback.test.ts -- all 28 appearance
 * keys (section 1.5 FA rows), setGreeting(null) (FB-02b), setListener(null)
 * (FB-03c), use before launch() (FB-07) and the e-mail screen (FB-06).
 *
 * Scenarios (scenarios/api-ui.ts):
 *   api-feedback-keys       every key set to its FEEDBACK_COLOURS colour, read
 *                           back, foreign keys tried; the chat, with an e-mail
 *                           user id so no e-mail screen comes first.
 *   api-feedback-email      the same keys and no user id. Android: the app's
 *                           data is cleared first (`pm clear`), so the
 *                           "notify me by e-mail" screen opens.
 *   api-feedback-null       setGreeting then setGreeting(null); a listener,
 *                           then setListener(null) twice; the chat.
 *   api-feedback-prelaunch  setGreeting, a colour, setListener, showFeedbackUI,
 *                           all before launch().
 *
 * iOS: the SwiftUI chat ignores BugseeTheme (bugsee-cocoa#200, bug 9), so on
 * iOS the chat's pixel results are recorded, not asserted (plan 1.5); the
 * e-mail screen's are asserted like Android's.
 *
 * Not reachable offline (read back only): pressed states (M-A11), messages
 * and dates (M-C1, staging), the error, loading and version-changed states,
 * and the input text colour (no text typed).
 */
import { apiMarker, jsonAfter, type Settled } from './api-markers';
import { FEEDBACK_COLOURS, FEEDBACK_KEYS } from '../scenarios/api-constants';
import { ANDROID_PACKAGE } from './device';
import { ON_ANDROID, ON_IOS, type Run, TARGET_NAME, describeDevice, must, report, startRun, stopApp } from './harness';
import { colourOf, colourPixels } from './media';
import { androidTopActivity, beginRetainingSuite, captureScreen, endRetainingSuite, ocrLines } from './observe';
import { type DeviceLog, adbStatus } from './scenario';
import { uiDump } from './screen';

jest.setTimeout(8 * 60_000);

const PLATFORM = ON_IOS ? 'ios' : 'android';
const BOUND: readonly string[] = FEEDBACK_KEYS[PLATFORM];
const FEEDBACK_ACTIVITY = `${ANDROID_PACKAGE}/com.bugsee.library.feedback.FeedbackActivity`;
const MIN_PIXELS = 40;

/** Keys the open chat paints, per platform. */
const CHAT_PIXEL: Record<'android' | 'ios', readonly string[]> = {
  android: ['actionBarColor', 'backgroundColor', 'bottomDelimiterColor', 'inputTextHintColor', 'titleTextColor'],
  ios: ['backgroundColor', 'barsColor', 'closeButtonColor', 'inputBackgroundColor', 'navigationBarColor', 'titleTextColor'],
};
/** Keys the e-mail screen paints, per platform. */
const EMAIL_PIXEL: Record<'android' | 'ios', readonly string[]> = {
  android: ['emailBackgroundColor', 'emailContinueNotActiveColor', 'emailSkipTextColor'],
  ios: ['emailBackgroundColor', 'emailContinueNotActiveColor', 'emailSkipColor'],
};

function faOf(key: string): string {
  return `FA-${String(Object.keys(FEEDBACK_COLOURS).indexOf(key) + 1).padStart(2, '0')}`;
}

/** Folds the characters OCR confuses (1/l/I/|, 0/O/o) together. */
function ocrFold(text: string): string {
  return text.replace(/[lI|]/g, '1').replace(/[Oo]/g, '0');
}

describeDevice(`the feedback package's keys, nulls and pre-launch use on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await beginRetainingSuite('N-14');
  });

  afterAll(async () => {
    try {
      // The e-mail user ids set here outlive the app (as feedback.test.ts).
      const clearer = await startRun('attributes-persist');
      must(await log!.waitFor(/BUGSEE_E2E attr cleared-id \{"type":"undefined"\}/, 30_000, clearer.start), 'the user identifier cleared', clearer.start);
    } finally {
      await endRetainingSuite(log);
    }
  });

  async function back(): Promise<void> {
    if (ON_ANDROID) {
      await adbStatus('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    }
    await stopApp();
  }

  describe('every key, on the chat', () => {
    let run: Run;
    let readback: Record<string, string | null>;
    let foreign: Record<string, string>;
    let shot: string;

    beforeAll(async () => {
      run = await startRun('api-feedback-keys');
      const nonce = run.scenario.nonce;
      readback = jsonAfter(( await apiMarker(log!, 'feedback-keys readback', nonce, 20_000, run.start)).text, 'values');
      foreign = jsonAfter((await apiMarker(log!, 'feedback-keys foreign', nonce, 5_000, run.start)).text, 'values');
      await apiMarker(log!, 'feedback shown', nonce, 10_000, run.start);
      await new Promise(resolve => setTimeout(resolve, 6_000));
      if (ON_ANDROID) {
        report('top activity', await androidTopActivity());
      }
      shot = await captureScreen('feedback-keys');
      report('readback', readback);
      report('foreign', foreign);
    });

    afterAll(back);

    for (const key of Object.keys(FEEDBACK_COLOURS)) {
      if (!BOUND.includes(key)) {
        it(`[${faOf(key)}] ${key} has no ${PLATFORM} binding: setting it throws RangeError and it reads back undefined`, () => {
          expect(foreign[key]).toMatch(/^RangeError: /);
          expect(readback[key]).toBeNull();
        });
        continue;
      }
      it(`[${faOf(key)}] ${key} reads back as set`, () => {
        expect(foreign[key]).toBeUndefined();
        expect(readback[key]).toBe(`${FEEDBACK_COLOURS[key]}ff`);
      });
      if (!CHAT_PIXEL[PLATFORM].includes(key)) {
        continue;
      }
      if (ON_IOS) {
        it(`[${faOf(key)}] ${key} on the chat: pixel count recorded (bug 9, bugsee-cocoa#200: the chat ignores BugseeTheme)`, async () => {
          const found = await colourPixels(shot, colourOf(FEEDBACK_COLOURS[key]!), 20);
          report(`${key} ${FEEDBACK_COLOURS[key]} pixels (recorded)`, { count: found.count, box: found.box });
        });
        continue;
      }
      it(`[${faOf(key)}] ${key} paints the chat`, async () => {
        const found = await colourPixels(shot, colourOf(FEEDBACK_COLOURS[key]!), 20);
        report(`${key} ${FEEDBACK_COLOURS[key]} pixels`, { count: found.count, box: found.box });
        expect(found.count).toBeGreaterThan(MIN_PIXELS);
      });
    }
  });

  describe('the e-mail screen on a first open', () => {
    let run: Run;
    let shot: string;
    let text: string[];
    let dump = '';

    beforeAll(async () => {
      if (ON_ANDROID) {
        // A fresh install as far as the feedback store knows.
        await adbStatus('shell', 'pm', 'clear', ANDROID_PACKAGE);
      }
      run = await startRun('api-feedback-email');
      await apiMarker(log!, 'feedback shown', run.scenario.nonce, 20_000, run.start);
      await new Promise(resolve => setTimeout(resolve, 6_000));
      shot = await captureScreen('feedback-email');
      text = await ocrLines(shot);
      report('e-mail screen text', text);
      if (ON_ANDROID) {
        report('top activity', await androidTopActivity());
        dump = (await uiDump()).xml;
        report('e-mail screen nodes', [...dump.matchAll(/<node [^>]*(text="[^"]*")[^>]*(class="[^"]*")/g)].map(m => `${m[2]} ${m[1]}`).slice(0, 40));
      }
    });

    afterAll(back);

    it('[FB-06] the first open shows the e-mail screen, not the chat', async () => {
      if (ON_ANDROID) {
        expect(await androidTopActivity()).toBe(FEEDBACK_ACTIVITY);
        // An e-mail field to type into, which the chat screen does not have.
        expect(dump).toMatch(/class="android\.widget\.EditText"[^>]*>|class="android\.widget\.EditText"/);
        expect(dump.toLowerCase()).toMatch(/e-?mail|почт/);
      } else {
        expect(text.join(' ').toLowerCase()).toMatch(/e-?mail/);
      }
    });

    for (const key of EMAIL_PIXEL[PLATFORM]) {
      it(`[${faOf(key)}] ${key} paints the e-mail screen`, async () => {
        const found = await colourPixels(shot, colourOf(FEEDBACK_COLOURS[key]!), 20);
        report(`${key} ${FEEDBACK_COLOURS[key]} pixels`, { count: found.count, box: found.box });
        expect(found.count).toBeGreaterThan(MIN_PIXELS);
      });
    }
  });

  describe('setGreeting(null) and setListener(null)', () => {
    let run: Run;
    let calls: Record<string, Settled>;
    let text: string[];

    beforeAll(async () => {
      run = await startRun('api-feedback-null');
      const line = await apiMarker(log!, 'feedback null', run.scenario.nonce, 20_000, run.start);
      calls = jsonAfter(line.text, 'calls');
      report('calls', calls);
      await new Promise(resolve => setTimeout(resolve, 6_000));
      text = await ocrLines(await captureScreen('feedback-null'));
      report('chat text', text);
    });

    afterAll(back);

    it('[FB-02b] setGreeting(null) clears the greeting: the chat opens without it', () => {
      expect(calls.greeting!.ok && calls.greetingNull!.ok).toBe(true);
      expect(text).toContain('Feedback');
      expect(text.map(ocrFold).join(' ')).not.toContain(ocrFold(`hello-gone ${run.scenario.nonce}`));
    });

    it('[FB-03c] setListener(null) is accepted, twice, and the chat still opens', () => {
      expect(calls.listener!.ok && calls.listenerNull!.ok && calls.listenerNullAgain!.ok).toBe(true);
      expect(text).toContain('Feedback');
    });
  });

  it('[FB-07] the package used before launch() does not crash the app, which still launches', async () => {
    const run = await startRun('api-feedback-prelaunch');
    const pre = await apiMarker(log!, 'feedback prelaunch', run.scenario.nonce, 20_000, run.start);
    const launched = await apiMarker(log!, 'feedback prelaunch launched', run.scenario.nonce, 30_000, run.start);
    await new Promise(resolve => setTimeout(resolve, 5_000));
    const top = ON_ANDROID ? await androidTopActivity() : undefined;
    report('pre-launch calls', pre.text.trim());
    report('after launch', { launched: launched.text.trim(), top });
    const calls = jsonAfter<Record<string, Settled>>(pre.text, 'calls');
    report('documented outcome (calls before launch)', calls);
    for (const [name, settled] of Object.entries(calls)) {
      expect({ name, ok: settled.ok }).toEqual({ name, ok: true });
    }
    expect(launched.text).toMatch(/ status=2\b/);
    if (ON_ANDROID) {
      // Still alive: the app's own task is on top, the SDK's chat or the app.
      expect(top).toMatch(new RegExp(`^${ANDROID_PACKAGE}/`));
    }
    await back();
  });
});
