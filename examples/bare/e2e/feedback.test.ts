/**
 * FB-01, FB-02, FB-04, FB-05: `@bugsee/react-native-feedback` on a device.
 *
 * Drives scenarios/feedback.ts. Both scenarios set a greeting carrying the
 * nonce (`hello <nonce>`), a chat background of #112233, a listener, and
 * call `showFeedbackUI()`:
 *   feedback       as the app ships it. The first time ever, the SDKs may
 *                  open on a "notify me by e-mail" screen.
 *   feedback-chat  first sets an e-mail-shaped user identifier, which both
 *                  SDKs take as the chat's e-mail, so the chat itself opens
 *                  with no tap.
 *
 * What is read, and from where -- nothing here taps the screen:
 *   - Android: the top-resumed activity (`dumpsys activity`) is the SDK's
 *     FeedbackActivity, in this app's task; a screen capture.
 *   - iOS: a screen capture (simctl / devicectl), read by macOS Vision
 *     (e2e/ocr.swift) -- iOS has no accessibility dump the e2e can read.
 *
 * Needs a human (MANUAL, see the beta-coverage report): sending a message
 * and receiving a reply (setListener's two callbacks, FB-03), which also
 * needs a real backend.
 */
import { colourOf, colourPixels } from './media';
import { ON_ANDROID, ON_IOS, type Run, TARGET_NAME, describeDevice, must, report, startRun } from './harness';
import { androidTopActivity, beginRetainingSuite, captureScreen, endRetainingSuite, ocrLines } from './observe';
import { type DeviceLog, adbStatus } from './scenario';

jest.setTimeout(6 * 60_000);

/** Folds the characters OCR confuses (1/l/I/|, 0/O/o) together. */
function ocrFold(text: string): string {
  return text.replace(/[lI|]/g, '1').replace(/[Oo]/g, '0');
}

const FEEDBACK_ACTIVITY = 'com.bareexample/com.bugsee.library.feedback.FeedbackActivity';
/** scenarios/feedback.ts `appearance.backgroundColor`. */
const CHAT_BACKGROUND = '#112233';

/**
 * The iOS SwiftUI chat (7.0.0-beta3 and beta4) ignores BugseeTheme, a
 * documented limitation (packages/react-native-feedback/README.md): seen
 * white (#ffffff) on the simulator with #112233 set. Pinned until it does.
 * Filed: https://github.com/bugsee/bugsee-cocoa/issues/200
 */
const itColour = ON_IOS ? it.failing : it;
/**
 * Android 7.3.0 stored the greeting and never read it back: the chat opened
 * empty (bugsee-android #215). 7.3.1 shows it in an empty chat (#225), as iOS
 * does.
 */
const itGreeting = it;

describeDevice(`the feedback chat on ${TARGET_NAME}`, () => {
  let log: DeviceLog | undefined;

  beforeAll(async () => {
    log = await beginRetainingSuite('beta-feedback');
  });

  afterAll(async () => {
    try {
      // feedback-chat set an e-mail user identifier, which outlives the
      // container wipe (the iOS Keychain; Android's SDK store): clear it
      // the way attributes.test.ts does, with its `attributes-persist`.
      const clearer = await startRun('attributes-persist');
      must(
        await log!.waitFor(/BUGSEE_E2E attr cleared-id \{"type":"undefined"\}/, 30_000, clearer.start),
        'the user identifier cleared after the feedback-chat runs',
        clearer.start,
      );
    } finally {
      await endRetainingSuite(log);
    }
  });

  /** Starts `scenario`, waits for its `shown` marker, lets the UI settle. */
  async function show(scenario: 'feedback' | 'feedback-chat'): Promise<Run> {
    const run = await startRun(scenario);
    must(
      await log!.waitFor(new RegExp(`BUGSEE_E2E feedback shown nonce=${run.scenario.nonce}`), 20_000, run.start),
      'showFeedbackUI() returning',
      run.start,
    );
    // The chat is presented on the next main-thread turn (Android after a
    // storage-thread hop); a capture right away can still see the app.
    await new Promise(resolve => setTimeout(resolve, 6_000));
    return run;
  }

  async function screenText(label: string): Promise<string[]> {
    const shot = await captureScreen(label);
    const lines = await ocrLines(shot);
    report(`${label} text`, lines);
    return lines;
  }

  it('showFeedbackUI() puts the feedback screen in front of the app', async () => {
    await show('feedback');
    if (ON_ANDROID) {
      const top = await androidTopActivity();
      report('top activity', top);
      expect(top).toBe(FEEDBACK_ACTIVITY);
    }
    // Both platforms title the screen "Feedback", in every locale tried.
    // Since Android 7.3.1 paints the feedback action bar (bugsee-android
    // #218), OCR can read the back arrow into the title's line ("< Feedback");
    // the arrow glyph is dropped, the title still has to match exactly.
    const text = await screenText('feedback');
    expect(text.map(line => line.replace(/^[<‹←]\s*/, ''))).toContain('Feedback');
    // The app's own screen is gone from view: its status label is not read.
    expect(text).not.toContain('Bugsee React Native');
  });

  itGreeting('the chat shows the greeting setGreeting() set', async () => {
    const run = await show('feedback-chat');
    if (ON_ANDROID) {
      expect(await androidTopActivity()).toBe(FEEDBACK_ACTIVITY);
    }
    const text = await screenText('feedback-chat');
    // OCR reads a hex nonce's 1 as l or I now and then: compare on the
    // characters it can tell apart.
    expect(text.map(ocrFold)).toContain(ocrFold(`hello ${run.scenario.nonce}`));
  });

  itColour('the chat is painted in the appearance background color', async () => {
    await show('feedback-chat');
    if (ON_ANDROID) {
      expect(await androidTopActivity()).toBe(FEEDBACK_ACTIVITY);
    }
    const shot = await captureScreen('feedback-chat-colour');
    const found = await colourPixels(shot, colourOf(CHAT_BACKGROUND), 4);
    report('chat background pixels', { count: found.count, of: found.width * found.height, box: found.box });
    // Most of the screen: everything but the status bar, title bar and input.
    expect(found.count).toBeGreaterThan(0.5 * found.width * found.height);
    if (ON_ANDROID) {
      await adbStatus('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    }
  });
});
