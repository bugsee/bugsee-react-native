/**
 * The secure-rectangle scenario (e2e/secure-rectangles.test.ts, final-review
 * fix B1).
 *
 * `secure` mounts one probe view near the top of the screen -- where the
 * status bar and cutout sit, so a window-vs-display offset shows up -- then
 * measures it with `measureInWindow` and publishes it through
 * `Bugsee.setSecureRectangles`, exactly as an app would. The test compares
 * the rectangle the native store serves the SDK with the probe's on-screen
 * bounds from the accessibility tree (`uiautomator dump`), which is display
 * pixels by construction.
 */
import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Bugsee from '@bugsee/react-native';

export const SECURE_SCENARIOS = ['secure'] as const;

export type SecureScenario = (typeof SECURE_SCENARIOS)[number];

export function isSecureScenario(name: string): name is SecureScenario {
  return (SECURE_SCENARIOS as readonly string[]).includes(name);
}

/** The accessibility label the e2e finds the probe by. */
export const SECURE_PROBE_LABEL = 'bugsee-secure-probe';

export function SecureProbe({ nonce }: { nonce: string }) {
  const probe = useRef<View>(null);

  const publish = () => {
    probe.current?.measureInWindow((x, y, width, height) => {
      try {
        Bugsee.setSecureRectangles([{ x, y, width, height }]);
        console.log(
          `BUGSEE_E2E secure published x=${x} y=${y} w=${width} h=${height} nonce=${nonce}`,
        );
      } catch (error) {
        console.log(`BUGSEE_E2E secure threw ${String(error)} nonce=${nonce}`);
      }
    });
  };

  return (
    <View
      ref={probe}
      collapsable={false}
      accessible
      accessibilityLabel={SECURE_PROBE_LABEL}
      testID={SECURE_PROBE_LABEL}
      onLayout={publish}
      style={styles.probe}
    />
  );
}

const styles = StyleSheet.create({
  probe: {
    position: 'absolute',
    top: 6,
    left: 17,
    width: 181,
    height: 47,
    backgroundColor: '#2a3140',
  },
});
