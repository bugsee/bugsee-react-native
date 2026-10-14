/**
 * `<BugseeSecure>` stays covered through what native draws after or beside
 * React (the follow-up to #87), asserted by e2e/secure-transitions.test.ts.
 *
 *   secure-transitions  three steps, each logging `secure-transitions
 *                       phase=<phase>` markers the test lines native's
 *                       publishes up against:
 *     - unmount: a `<BugseeSecure>` is unmounted (`unmounted`), and 250 ms
 *       later (`held`) and 1.5 s later (`gone`) the step logs again;
 *     - modal: a transparent `<Modal animationType="slide">` holding a
 *       `<BugseeSecure>` opens (`modal-opening`, then `modal-opened` 250 ms
 *       later and `modal-settled` 1.5 s later), and closes the same way
 *       (`modal-closing`, `modal-closed`, `modal-gone`);
 *     - native: a `<BugseeSecure>` under an `Animated.View` whose translateX
 *       a native-driven timing animation moves from 0 to 120 points; 600 ms
 *       after it ends (`native-moved`) the step logs the view's window
 *       rectangle as React Native measures it, which never saw the move.
 *   Every marker carries `self=x,y,w,h` (window points, `none` if unmounted)
 *   and `ratio=` the pixel ratio.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, PixelRatio, StyleSheet, View } from 'react-native';
import { BugseeSecure } from '@bugsee/react-native';

export const SECURE_TRANSITIONS_SCENARIO = 'secure-transitions';

/** What the native-driven animation moves the view by, in points. */
export const NATIVE_SHIFT = 120;

function mark(message: string): void {
  console.log(`BUGSEE_E2E ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type Measurable = { measureInWindow(cb: (x: number, y: number, w: number, h: number) => void): void };

function measured(view: Measurable | null): Promise<string> {
  return new Promise(resolve => {
    if (view === null) {
      resolve('none');
      return;
    }
    view.measureInWindow((x, y, w, h) => resolve(`${x},${y},${w},${h}`));
  });
}

const BOX = { position: 'absolute', top: 200, left: 40, width: 200, height: 80 } as const;

export function SecureTransitionsProbe({ nonce }: { nonce: string }) {
  const [plain, setPlain] = useState(true);
  const [modal, setModal] = useState(false);
  const [animated, setAnimated] = useState(false);
  const shift = useRef(new Animated.Value(0)).current;
  const twin = useRef<View>(null);
  const modalTwin = useRef<View>(null);
  const animatedTwin = useRef<View>(null);

  useEffect(() => {
    const log = async (phase: string, view: View | null) => {
      const self = await measured(view);
      mark(`secure-transitions phase=${phase} self=${self} ratio=${PixelRatio.get()} nonce=${nonce}`);
    };
    (async () => {
      await sleep(1500);
      await log('mounted', twin.current);
      setPlain(false);
      await log('unmounted', null);
      await sleep(250);
      await log('held', null);
      await sleep(1250);
      await log('gone', null);

      setModal(true);
      await log('modal-opening', null);
      await sleep(250);
      await log('modal-opened', modalTwin.current);
      await sleep(1250);
      await log('modal-settled', modalTwin.current);
      setModal(false);
      await log('modal-closing', null);
      await sleep(250);
      await log('modal-closed', null);
      await sleep(1250);
      await log('modal-gone', null);

      setAnimated(true);
      await sleep(1500);
      await log('native-rest', animatedTwin.current);
      await new Promise<void>(resolve => {
        Animated.timing(shift, { toValue: NATIVE_SHIFT, duration: 300, useNativeDriver: true }).start(() =>
          resolve(),
        );
      });
      await sleep(600);
      await log('native-moved', animatedTwin.current);
      mark(`secure-transitions done nonce=${nonce}`);
    })().catch((error: unknown) => {
      mark(`secure-transitions threw ${String(error)} nonce=${nonce}`);
    });
  }, [nonce, shift]);

  return (
    <View style={styles.stage}>
      {plain && (
        <>
          <BugseeSecure style={BOX} />
          <View ref={twin} collapsable={false} pointerEvents="none" style={BOX} />
        </>
      )}
      <Modal visible={modal} transparent animationType="slide" onRequestClose={() => setModal(false)}>
        <View style={styles.fill}>
          <BugseeSecure style={BOX} />
          <View ref={modalTwin} collapsable={false} pointerEvents="none" style={BOX} />
        </View>
      </Modal>
      {animated && (
        <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: shift }] }]}>
          <BugseeSecure style={BOX} />
          <View ref={animatedTwin} collapsable={false} pointerEvents="none" style={BOX} />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#FFFFFF' },
  fill: { flex: 1 },
});
