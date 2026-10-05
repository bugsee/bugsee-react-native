/**
 * The Phase 6 privacy scenarios (Task 6.8): blackout, `<BugseeSecure>` and
 * the view tree, each asserted on the retained report bundles by
 * e2e/blackout.test.ts, e2e/secure-component.test.ts and
 * e2e/view-tree.test.ts.
 *
 * Every scenario runs on the same white stage: a full-screen `#FFFFFF` view
 * with a 40x40 black square sliding left and right across the top 15% of the
 * screen on the native driver. The motion keeps frames flowing (Android skips
 * unchanged frames, iOS captures adaptively), and the square stays out of
 * every centre crop and region the tests measure. Against white, a dark
 * region can only be the SDK's own mask.
 *
 *   blackout            3 s on the stage, then a blackout with a view-tree
 *                       capture and an upload inside it, then an upload after
 *                       it has ended.
 *   blackout-prelaunch  startBlackout() before launch(), read back after.
 *   secure-component    a white-on-white <BugseeSecure> in a ScrollView:
 *                       mounted, scrolled, unmounted, with an upload at each.
 *   view-tree           BugseeE2EViewTreeProbe: an open view holding text, a
 *                       <BugseeSecure> with ids inside, and a TextInput, then
 *                       an explicit view-tree capture and an upload.
 *
 * Markers are `BUGSEE_E2E <scenario> ...` and carry the run's nonce. No marker
 * ever carries the probe's text or the TextInput's value: the app's own log
 * lands in the bundle, and the tests assert that neither does.
 *
 * The two component scenarios hold still after each upload, so the test can
 * read the probe's on-screen bounds from the accessibility tree while it is
 * where the report saw it. `uiautomator dump` (about 3.5 s on the WOD_LX1)
 * needs an idle UI, which the moving square never allows, so the square
 * stops for the hold: `SETTLE_MS` after the upload (the report's screenshot
 * is long taken by then), marked `still phase=<phase>`, for `HOLD_MS`. It is
 * moving again before the next change on screen, and for 1.5 s before the
 * next upload.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  PixelRatio,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Bugsee, { BugseeSecure } from '@bugsee/react-native';

export const PRIVACY_SCENARIOS = [
  'blackout',
  'blackout-prelaunch',
  'secure-component',
  'secure-modal',
  'secure-modal-translucent',
  'secure-modal-sheet',
  'view-tree',
] as const;

export type PrivacyScenario = (typeof PRIVACY_SCENARIOS)[number];

export function isPrivacyScenario(name: string): name is PrivacyScenario {
  return (PRIVACY_SCENARIOS as readonly string[]).includes(name);
}

/** From an upload to the square stopping. */
export const SETTLE_MS = 3_000;
/** How long the square stays stopped for the test's UI dump. */
export const HOLD_MS = 8_000;

/** The accessibility labels the tests find the probes by (uiautomator). */
export const SECURE_COMPONENT_LABEL = 'bugsee-secure-component';
export const SECURE_WITNESS_LABEL = 'bugsee-secure-witness';
export const SECURE_MODAL_MAIN_LABEL = 'bugsee-secure-modal-main';
export const SECURE_MODAL_SHEET_LABEL = 'bugsee-secure-modal-sheet';
/**
 * The two secure views' colours: nothing else on screen is either, so a
 * device screenshot finds where each one really is, and a recording that
 * shows either colour has leaked it.
 */
export const SECURE_MODAL_MAIN_COLOUR = '#FF00FF';
export const SECURE_MODAL_SHEET_COLOUR = '#00FFFF';
/**
 * A witness inside the Modal, not secure, in a colour of its own: a video
 * frame that shows it shows the Modal, so the frames the test checks the
 * Modal's secure view in are found from the video itself.
 */
export const SECURE_MODAL_WITNESS_COLOUR = '#FF0000';
const MODAL_WITNESS_RECT = { position: 'absolute', top: 340, left: 80, width: 80, height: 80 } as const;

/**
 * The Modal each `secure-modal*` scenario shows:
 *  - `secure-modal`: `transparent` (overFullScreen on iOS).
 *  - `secure-modal-translucent`: also `statusBarTranslucent`. With Android
 *    edge-to-edge off, the dialog's content then starts under the status bar
 *    while the activity root starts below it, so the two surfaces' origins
 *    differ.
 *  - `secure-modal-sheet`: an opaque `pageSheet` (iOS), whose content is
 *    inset inside the window.
 */
export type SecureModalVariant = 'secure-modal' | 'secure-modal-translucent' | 'secure-modal-sheet';
export const VH_OPEN_LABEL = 'vh-open-probe';

function mark(message: string): void {
  console.log(`BUGSEE_E2E ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Logs `BUGSEE_E2E blackout lifecycle <name>` for the two blackout events.
 * Subscribed before launch(), so an event the SDK dispatched early would be
 * seen too.
 */
function subscribeBlackoutLifecycle(nonce: string): void {
  Bugsee.onLifecycleEvent(event => {
    if (event.name === 'BlackoutStarted' || event.name === 'BlackoutEnded') {
      mark(`blackout lifecycle ${event.name} t=${Date.now()} nonce=${nonce}`);
    }
  });
}

/** Called before `launch()`. */
export function preLaunchPrivacyProbe(scenario: PrivacyScenario, nonce: string): void {
  if (scenario !== 'blackout' && scenario !== 'blackout-prelaunch') {
    return;
  }
  subscribeBlackoutLifecycle(nonce);
  if (scenario === 'blackout-prelaunch') {
    Bugsee.startBlackout();
    mark(`blackout prelaunch-called nonce=${nonce}`);
  }
}

async function runBlackout(nonce: string): Promise<void> {
  await sleep(3000);
  Bugsee.startBlackout();
  const startedT = Date.now();
  mark(`blackout started t=${startedT} isBlackout=${String(await Bugsee.isBlackout())} nonce=${nonce}`);
  await sleep(2000);
  Bugsee.captureViewHierarchy();
  mark(`blackout captured t=${Date.now()} nonce=${nonce}`);
  await sleep(500);
  Bugsee.upload(`blackout-during-${nonce}`, '');
  mark(`blackout uploaded-during t=${Date.now()} nonce=${nonce}`);
  await sleep(2000);
  Bugsee.endBlackout();
  const endedT = Date.now();
  mark(`blackout ended t=${endedT} isBlackout=${String(await Bugsee.isBlackout())} nonce=${nonce}`);
  await sleep(3000);
  Bugsee.upload(`blackout-after-${nonce}`, '');
  mark(`blackout uploaded-after t=${Date.now()} nonce=${nonce}`);
}

async function runBlackoutPrelaunch(nonce: string): Promise<void> {
  mark(`blackout prelaunch isBlackout=${String(await Bugsee.isBlackout())} nonce=${nonce}`);
  Bugsee.endBlackout();
  mark(`blackout prelaunch-cleared isBlackout=${String(await Bugsee.isBlackout())} nonce=${nonce}`);
}

/**
 * Called once the SDK is `Launched`. The two component scenarios run from
 * their own components' effects instead (`PrivacyStage`).
 */
export function runPrivacyScenario(scenario: PrivacyScenario, nonce: string): void {
  const run =
    scenario === 'blackout'
      ? runBlackout(nonce)
      : scenario === 'blackout-prelaunch'
        ? runBlackoutPrelaunch(nonce)
        : Promise.resolve();
  run.catch((error: unknown) => {
    mark(`${scenario} threw ${String(error)} nonce=${nonce}`);
  });
}

type Measurable = { measureInWindow(cb: (x: number, y: number, w: number, h: number) => void): void };

function measure(view: Measurable | null): Promise<{ x: number; y: number; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    if (view === null) {
      reject(new Error('nothing to measure'));
      return;
    }
    view.measureInWindow((x, y, w, h) => resolve({ x, y, w, h }));
  });
}

function screenLine(): string {
  const screen = Dimensions.get('screen');
  return `screen=${screen.width}x${screen.height} ratio=${PixelRatio.get()}`;
}

/**
 * The black square, sliding across the top 15% of the screen while `moving`.
 * Stopped only while a test reads the accessibility tree: `uiautomator dump`
 * waits for the UI to go idle, and a view moving every frame never lets it
 * (seen on the WOD_LX1: "could not get idle state" on every try).
 */
function MovingSquare({ moving }: { moving: boolean }) {
  const x = useRef(new Animated.Value(0)).current;
  const { width, height } = Dimensions.get('window');
  useEffect(() => {
    if (!moving) {
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(x, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(x, { toValue: 0, duration: 1200, easing: Easing.linear, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [x, moving]);
  const travel = width - SQUARE;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.square,
        {
          top: Math.round(height * 0.15) - SQUARE - 8,
          transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, travel] }) }],
        },
      ]}
    />
  );
}

const SQUARE = 40;

interface ProbeProps {
  nonce: string;
  /** Starts or stops the stage's square. */
  setMoving: (moving: boolean) => void;
}

const SECURE_RECT = { position: 'absolute', top: 260, left: 60, width: 180, height: 90 } as const;

/**
 * secure-component: a white `<BugseeSecure>` on white content three screens
 * tall. A transparent twin at the same rectangle is what gets measured, since
 * `<BugseeSecure>` takes no ref.
 *
 * The witness is a black square fixed near the bottom-left corner, outside
 * the ScrollView, rendered by the same `mounted` flag as the component: it
 * appears and disappears in the same commit. A video frame that shows it is
 * therefore a frame the component is on screen in, which is how the test
 * picks "every frame after the component mounts" without mapping clocks.
 */
function SecureComponentProbe({ nonce, setMoving }: ProbeProps) {
  const scroll = useRef<ScrollView>(null);
  const twin = useRef<View>(null);
  const witness = useRef<View>(null);
  const [mounted, setMounted] = useState(true);
  const height = Dimensions.get('window').height;

  // After <BugseeSecure>'s own layout effect (children commit first), so
  // `t` is no earlier than its first published rectangle and no later than
  // its first paint.
  useLayoutEffect(() => {
    mark(`secure-component mounted t=${Date.now()} nonce=${nonce}`);
  }, [nonce]);

  useEffect(() => {
    const logRect = async (phase: string) => {
      const r = await measure(twin.current);
      mark(`secure-component rect phase=${phase} x=${r.x} y=${r.y} w=${r.w} h=${r.h} ${screenLine()} nonce=${nonce}`);
    };
    // Where the witness is, for a platform with no accessibility dump to
    // read it from (iOS, Task 6.9). It never moves.
    const logWitness = async () => {
      const r = await measure(witness.current);
      mark(`secure-component witness x=${r.x} y=${r.y} w=${r.w} h=${r.h} ${screenLine()} nonce=${nonce}`);
    };
    const hold = async (phase: string) => {
      await sleep(SETTLE_MS);
      setMoving(false);
      mark(`secure-component still phase=${phase} t=${Date.now()} nonce=${nonce}`);
      await sleep(HOLD_MS);
      setMoving(true);
    };
    (async () => {
      await sleep(1500);
      await logRect('mounted');
      Bugsee.upload(`secure-mounted-${nonce}`, '');
      mark(`secure-component uploaded phase=mounted t=${Date.now()} nonce=${nonce}`);
      // After the upload, so it cannot shift the report's timing.
      await logWitness();
      await hold('mounted');

      mark(`secure-component scrolling t=${Date.now()} nonce=${nonce}`);
      scroll.current?.scrollTo({ y: 100, animated: false });
      await sleep(1500);
      await logRect('scrolled');
      Bugsee.upload(`secure-scrolled-${nonce}`, '');
      mark(`secure-component uploaded phase=scrolled t=${Date.now()} nonce=${nonce}`);
      await hold('scrolled');

      mark(`secure-component unmounting t=${Date.now()} nonce=${nonce}`);
      setMounted(false);
      await sleep(1500);
      Bugsee.upload(`secure-unmounted-${nonce}`, '');
      mark(`secure-component uploaded phase=unmounted t=${Date.now()} nonce=${nonce}`);
      await sleep(SETTLE_MS);
      setMoving(false);
      mark(`secure-component still phase=unmounted t=${Date.now()} nonce=${nonce}`);
    })().catch((error: unknown) => {
      mark(`secure-component threw ${String(error)} nonce=${nonce}`);
    });
  }, [nonce, setMoving]);

  return (
    <>
      <ScrollView ref={scroll} style={StyleSheet.absoluteFill} contentContainerStyle={{ height: 3 * height }}>
        {mounted && (
          <BugseeSecure
            accessible
            accessibilityLabel={SECURE_COMPONENT_LABEL}
            style={{ ...SECURE_RECT, backgroundColor: '#FFFFFF' }}
          />
        )}
        <View ref={twin} collapsable={false} pointerEvents="none" style={SECURE_RECT} />
      </ScrollView>
      {mounted && (
        <View
          ref={witness}
          collapsable={false}
          accessible
          accessibilityLabel={SECURE_WITNESS_LABEL}
          pointerEvents="none"
          style={[styles.witness, { top: height - 160 }]}
        />
      )}
    </>
  );
}

const MODAL_MAIN_RECT = { position: 'absolute', top: 120, left: 40, width: 160, height: 80 } as const;
/** Same absolute box for the secure view and its measure twin (must overlap). */
const MODAL_SHEET_RECT = { position: 'absolute', top: 80, left: 80, width: 200, height: 100 } as const;

/**
 * secure-modal*: a coloured `<BugseeSecure>` on the activity root and another
 * inside a `<Modal>` (Android Dialog / iOS presented VC). Both must land in
 * display space for their own surface — the sheet must not be translated by
 * the activity root's origin alone. Markers are tagged with the scenario.
 */
function SecureModalProbe({ nonce, setMoving, variant }: ProbeProps & { variant: SecureModalVariant }) {
  const mainTwin = useRef<View>(null);
  const sheetTwin = useRef<View>(null);

  useLayoutEffect(() => {
    mark(`${variant} mounted t=${Date.now()} nonce=${nonce}`);
  }, [nonce, variant]);

  useEffect(() => {
    (async () => {
      await sleep(2000);
      const main = await measure(mainTwin.current);
      const sheet = await measure(sheetTwin.current);
      mark(
        `${variant} rect phase=both main=${main.x},${main.y},${main.w},${main.h} ` +
          `sheet=${sheet.x},${sheet.y},${sheet.w},${sheet.h} ${screenLine()} nonce=${nonce}`,
      );
      await sleep(1500);
      Bugsee.upload(`${variant}-${nonce}`, '');
      mark(`${variant} uploaded t=${Date.now()} nonce=${nonce}`);
      await sleep(SETTLE_MS);
      setMoving(false);
      mark(`${variant} still t=${Date.now()} nonce=${nonce}`);
      await sleep(HOLD_MS);
      setMoving(true);
    })().catch((error: unknown) => {
      mark(`${variant} threw ${String(error)} nonce=${nonce}`);
    });
  }, [nonce, setMoving, variant]);

  return (
    <>
      <BugseeSecure
        accessible
        accessibilityLabel={SECURE_MODAL_MAIN_LABEL}
        style={{ ...MODAL_MAIN_RECT, backgroundColor: SECURE_MODAL_MAIN_COLOUR }}
      />
      <View ref={mainTwin} collapsable={false} pointerEvents="none" style={MODAL_MAIN_RECT} />
      <Modal
        visible
        animationType="none"
        transparent={variant !== 'secure-modal-sheet'}
        statusBarTranslucent={variant === 'secure-modal-translucent'}
        presentationStyle={variant === 'secure-modal-sheet' ? 'pageSheet' : undefined}
      >
        <View style={styles.modalSheet} accessible accessibilityLabel="bugsee-secure-modal-backdrop">
          <BugseeSecure
            accessible
            accessibilityLabel={SECURE_MODAL_SHEET_LABEL}
            style={{ ...MODAL_SHEET_RECT, backgroundColor: SECURE_MODAL_SHEET_COLOUR }}
          />
          <View ref={sheetTwin} collapsable={false} pointerEvents="none" style={MODAL_SHEET_RECT} />
          <View style={{ ...MODAL_WITNESS_RECT, backgroundColor: SECURE_MODAL_WITNESS_COLOUR }} />
        </View>
      </Modal>
    </>
  );
}

/**
 * view-tree: what the managed tree must describe, and what it must never
 * carry (the text, the typed value, and every id under the secure boundary).
 * Named so the walk emits it as a composite.
 */
function BugseeE2EViewTreeProbe({ nonce, setMoving }: ProbeProps) {
  const open = useRef<View>(null);

  useEffect(() => {
    (async () => {
      await sleep(1000);
      const r = await measure(open.current);
      mark(`view-tree rect x=${r.x} y=${r.y} w=${r.w} h=${r.h} ${screenLine()} nonce=${nonce}`);
      Bugsee.captureViewHierarchy();
      mark(`view-tree captured t=${Date.now()} nonce=${nonce}`);
      await sleep(1000);
      Bugsee.upload(`vh-${nonce}`, '');
      mark(`view-tree uploaded t=${Date.now()} nonce=${nonce}`);
      await sleep(SETTLE_MS);
      setMoving(false);
      mark(`view-tree still t=${Date.now()} nonce=${nonce}`);
    })().catch((error: unknown) => {
      mark(`view-tree threw ${String(error)} nonce=${nonce}`);
    });
  }, [nonce, setMoving]);

  return (
    <>
      <View
        ref={open}
        testID={`vh-open-${nonce}`}
        nativeID={`vh-open-native-${nonce}`}
        accessible
        accessibilityLabel={VH_OPEN_LABEL}
        collapsable={false}
        style={{ position: 'absolute', top: 300, left: 30, width: 150, height: 60 }}
      >
        <Text>{`secret-text-${nonce}`}</Text>
      </View>
      <BugseeSecure
        testID={`vh-secure-${nonce}`}
        style={{ position: 'absolute', top: 400, left: 30, width: 150, height: 60 }}
      >
        <View
          testID={`vh-inner-${nonce}`}
          nativeID={`vh-native-${nonce}`}
          collapsable={false}
          style={{ flex: 1 }}
        />
      </BugseeSecure>
      <TextInput
        defaultValue={`typed-${nonce}`}
        style={{ position: 'absolute', top: 500, left: 30, width: 150, height: 40 }}
      />
    </>
  );
}

/**
 * The white stage, over everything else App renders. Mounted as soon as a
 * privacy scenario is chosen, so the video is white before the SDK starts;
 * the probes mount once the SDK is `Launched`.
 */
export function PrivacyStage({
  scenario,
  nonce,
  launched,
}: {
  scenario: PrivacyScenario;
  nonce: string;
  launched: boolean;
}) {
  const [moving, setMoving] = useState(true);
  return (
    <View style={styles.stage}>
      {launched && scenario === 'secure-component' && (
        <SecureComponentProbe nonce={nonce} setMoving={setMoving} />
      )}
      {launched &&
        (scenario === 'secure-modal' ||
          scenario === 'secure-modal-translucent' ||
          scenario === 'secure-modal-sheet') && (
          <SecureModalProbe nonce={nonce} setMoving={setMoving} variant={scenario} />
        )}
      {launched && scenario === 'view-tree' && (
        <BugseeE2EViewTreeProbe nonce={nonce} setMoving={setMoving} />
      )}
      <MovingSquare moving={moving} />
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#FFFFFF' },
  square: { position: 'absolute', left: 0, width: SQUARE, height: SQUARE, backgroundColor: '#000000' },
  witness: { position: 'absolute', left: 20, width: 80, height: 80, backgroundColor: '#000000' },
  modalSheet: {
    flex: 1,
    marginTop: 200,
    marginHorizontal: 24,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
});
