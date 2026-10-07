/**
 * The campaign API scenarios (PREP-api), in one place App.tsx calls:
 *
 *   isApiScenario(name)          every `api-*` name below
 *   apiLaunchOverrides(...)      their launch options, on App.tsx's typed model
 *   preLaunchApi(...)            before launch(); true = the scenario owns the
 *                                launch and App.tsx must not call launch()
 *   runApiScenario(...)          once Launched
 *   <ApiStage>                   what the rendering scenarios put on screen
 *
 * Groups: scenarios/api-lifecycle.ts (N-02, N-03, N-09), api-args.ts (N-08),
 * api-options.ts (N-06, N-07), api-ui.ts (N-05, N-11, N-13, N-14); the
 * secure-rectangle stage (N-04) and N-08's ErrorBoundary and BugseeSecure
 * stages are here.
 */
import { useEffect, useRef } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, Text, View } from 'react-native';
import Bugsee, { type BugseeLaunchOptions, BugseeSecure, ErrorBoundary } from '@bugsee/react-native';

import { type ApiContext, type ApiStageState, delay, mark } from './api-common';
import { ARGS_SCENARIOS, preLaunchArgs, runArgsScenario } from './api-args';
import { LIFECYCLE_SCENARIOS, preLaunchLifecycle, runLifecycleScenario } from './api-lifecycle';
import { effectOf, isOptionScenario, optionLaunchOverrides, preLaunchOptions, runOptionScenario } from './api-options';
import { UI_SCENARIOS, preLaunchUi, runUiScenario, uiLaunchOverrides } from './api-ui';

export type { ApiContext, ApiStageState } from './api-common';

/** Scenarios whose work is on screen (`ApiStage`). */
const STAGE_SCENARIOS = ['api-secure-rects', 'api-boundary', 'api-secure-off'] as const;

/** Effect cases that need a stage, and which. */
const EFFECT_STAGES: Readonly<Record<string, string>> = {
  'fps-max': 'moving',
  'fps-control--moving': 'moving',
  'fps-min': 'white',
  'fps-control--static': 'white',
  'flag-secure': 'white',
  'flag-secure-off': 'white',
};

const groups = {
  lifecycle: LIFECYCLE_SCENARIOS as readonly string[],
  args: ARGS_SCENARIOS as readonly string[],
  ui: UI_SCENARIOS as readonly string[],
  stage: STAGE_SCENARIOS as readonly string[],
};

export function isApiScenario(name: string): boolean {
  return (
    groups.lifecycle.includes(name) ||
    groups.args.includes(name) ||
    groups.ui.includes(name) ||
    groups.stage.includes(name) ||
    isOptionScenario(name)
  );
}

export function apiLaunchOverrides(scenario: string, options: BugseeLaunchOptions): void {
  if (!isApiScenario(scenario)) {
    return;
  }
  optionLaunchOverrides(scenario, options);
  uiLaunchOverrides(scenario, (key, value) => options.setCustomOption(key, value));
  if (scenario === 'api-filters') {
    options.setCustomOption('com.bugsee.option.capture.breadcrumbs', true);
  }
}

export async function preLaunchApi(scenario: string, nonce: string, context: ApiContext): Promise<boolean> {
  if (groups.lifecycle.includes(scenario)) {
    return preLaunchLifecycle(scenario, nonce);
  }
  if (groups.args.includes(scenario)) {
    await preLaunchArgs(scenario, nonce);
  }
  if (groups.ui.includes(scenario)) {
    await preLaunchUi(scenario, nonce);
  }
  if (isOptionScenario(scenario)) {
    return preLaunchOptions(scenario, nonce, context);
  }
  return false;
}

export async function runApiScenario(scenario: string, nonce: string, context: ApiContext): Promise<void> {
  try {
    const effect = effectOf(scenario);
    if (effect !== undefined) {
      const stage = EFFECT_STAGES[`${effect.case}--${effect.step}`] ?? EFFECT_STAGES[effect.case];
      if (stage !== undefined) {
        context.setStage({ scenario, nonce, step: stage });
        await delay(1_500);
      }
    }
    if (groups.lifecycle.includes(scenario)) {
      await runLifecycleScenario(scenario, nonce, context);
    } else if (groups.args.includes(scenario)) {
      await runArgsScenario(scenario, nonce);
    } else if (groups.ui.includes(scenario)) {
      if (scenario === 'api-sdk-crumbs') {
        context.setStage({ scenario, nonce, step: 'white' });
      }
      await runUiScenario(scenario, nonce);
    } else if (groups.stage.includes(scenario)) {
      context.setStage({ scenario, nonce, step: 'start' });
    } else if (isOptionScenario(scenario)) {
      await runOptionScenario(scenario, nonce, context);
    }
  } catch (error) {
    mark(`threw scenario=${scenario} nonce=${nonce} error=${String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Stages

type Measurable = { measureInWindow(cb: (x: number, y: number, w: number, h: number) => void): void } | null;

function measure(view: Measurable): Promise<{ x: number; y: number; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    if (view === null) {
      reject(new Error('not mounted'));
      return;
    }
    view.measureInWindow((x, y, w, h) => resolve({ x, y, w, h }));
  });
}

function screenLine(): string {
  const { width, height } = Dimensions.get('screen');
  return `screen=${width}x${height}`;
}

const PROBE_A = { position: 'absolute', top: 140, left: 40, width: 160, height: 100 } as const;
const PROBE_B = { position: 'absolute', top: 400, left: 120, width: 160, height: 100 } as const;

/**
 * N-04: two white probes on white. `set` publishes probe A for display 0;
 * `other` clears display 0 and publishes probe B for display 1 only; `clear`
 * clears display 1 too. One upload per step, with each probe's
 * measureInWindow rectangle logged first.
 */
function SecureRectsStage({ nonce }: { nonce: string }) {
  const a = useRef<View>(null);
  const b = useRef<View>(null);
  useEffect(() => {
    (async () => {
      await delay(1_500);
      const ra = await measure(a.current);
      const rb = await measure(b.current);
      mark(`rects probe=a x=${ra.x} y=${ra.y} w=${ra.w} h=${ra.h} ${screenLine()} nonce=${nonce}`);
      mark(`rects probe=b x=${rb.x} y=${rb.y} w=${rb.w} h=${rb.h} ${screenLine()} nonce=${nonce}`);
      const toRect = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x, y: r.y, width: r.w, height: r.h });

      Bugsee.setSecureRectangles([toRect(ra)]);
      await delay(2_000);
      Bugsee.upload(`api-rects-set-${nonce}`, '');
      mark(`rects uploaded step=set nonce=${nonce}`);
      await delay(5_000);

      Bugsee.setSecureRectangles([]);
      Bugsee.setSecureRectangles([toRect(rb)], 1);
      await delay(2_000);
      Bugsee.upload(`api-rects-other-${nonce}`, '');
      mark(`rects uploaded step=other nonce=${nonce}`);
      await delay(5_000);

      Bugsee.setSecureRectangles([], 1);
      await delay(2_000);
      Bugsee.upload(`api-rects-clear-${nonce}`, '');
      mark(`rects uploaded step=clear nonce=${nonce}`);
    })().catch(error => mark(`rects threw ${String(error)} nonce=${nonce}`));
  }, [nonce]);
  return (
    <View style={[StyleSheet.absoluteFill, styles.white]}>
      <View ref={a} collapsable={false} style={[PROBE_A, styles.white]} />
      <View ref={b} collapsable={false} style={[PROBE_B, styles.white]} />
    </View>
  );
}

function Thrower({ nonce }: { nonce: string }): never {
  throw new Error(`api-boundary render ${nonce}`);
}

/**
 * N-08: an ErrorBoundary whose fallback is a function and whose `options`
 * carry a domain and labels, around a child that throws on render.
 */
function BoundaryStage({ nonce }: { nonce: string }) {
  return (
    <View style={[StyleSheet.absoluteFill, styles.white]}>
      <ErrorBoundary
        options={{ domain: `api-domain-${nonce}`, labels: [`api-label-${nonce}`] }}
        onError={() => mark(`boundary onError nonce=${nonce}`)}
        fallback={({ error, componentStack }) => {
          mark(
            `boundary fallback nonce=${nonce} error=${error instanceof Error ? error.message : String(error)} ` +
              `stack=${typeof componentStack === 'string' && componentStack.includes('Thrower') ? 'has-thrower' : String(componentStack).slice(0, 60)}`,
          );
          return <Text style={styles.fallback}>{`fallback ${nonce}`}</Text>;
        }}>
        <Thrower nonce={nonce} />
      </ErrorBoundary>
    </View>
  );
}

const SECURE_ON = { position: 'absolute', top: 140, left: 40, width: 160, height: 100 } as const;
const SECURE_OFF = { position: 'absolute', top: 400, left: 120, width: 160, height: 100 } as const;

/**
 * N-08: `<BugseeSecure enabled>` and `<BugseeSecure enabled={false}>`, both
 * white on white, with transparent twins measured for the e2e.
 */
function SecureOffStage({ nonce }: { nonce: string }) {
  const on = useRef<View>(null);
  const off = useRef<View>(null);
  useEffect(() => {
    (async () => {
      await delay(2_000);
      const ron = await measure(on.current);
      const roff = await measure(off.current);
      mark(`secure-off probe=on x=${ron.x} y=${ron.y} w=${ron.w} h=${ron.h} ${screenLine()} nonce=${nonce}`);
      mark(`secure-off probe=off x=${roff.x} y=${roff.y} w=${roff.w} h=${roff.h} ${screenLine()} nonce=${nonce}`);
      Bugsee.upload(`api-secure-off-${nonce}`, '');
      mark(`secure-off uploaded nonce=${nonce}`);
    })().catch(error => mark(`secure-off threw ${String(error)} nonce=${nonce}`));
  }, [nonce]);
  return (
    <View style={[StyleSheet.absoluteFill, styles.white]}>
      <BugseeSecure style={[SECURE_ON, styles.white]} />
      <BugseeSecure enabled={false} style={[SECURE_OFF, styles.white]} />
      <View ref={on} collapsable={false} pointerEvents="none" style={SECURE_ON} />
      <View ref={off} collapsable={false} pointerEvents="none" style={SECURE_OFF} />
    </View>
  );
}

/** A black square crossing a white screen, forever: every frame differs. */
function MovingStage() {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(x, { toValue: 1, duration: 1_000, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [x]);
  const width = Dimensions.get('window').width;
  return (
    <View style={[StyleSheet.absoluteFill, styles.white]}>
      <Animated.View
        style={[styles.square, { transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, width - 80] }) }] }]}
      />
    </View>
  );
}

export function ApiStage({ stage }: { stage: ApiStageState }) {
  switch (stage.step === 'start' ? stage.scenario : stage.step) {
    case 'api-secure-rects':
      return <SecureRectsStage nonce={stage.nonce} />;
    case 'api-boundary':
      return <BoundaryStage nonce={stage.nonce} />;
    case 'api-secure-off':
      return <SecureOffStage nonce={stage.nonce} />;
    case 'moving':
      return <MovingStage />;
    case 'white':
      return <View style={[StyleSheet.absoluteFill, styles.white]} />;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  white: { backgroundColor: '#ffffff' },
  square: { position: 'absolute', top: 300, left: 0, width: 80, height: 80, backgroundColor: '#000000' },
  fallback: { marginTop: 300, textAlign: 'center', color: '#000000', fontSize: 20 },
});
