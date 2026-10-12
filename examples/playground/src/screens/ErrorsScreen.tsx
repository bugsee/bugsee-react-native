import { useState } from 'react';
import { Button, Platform, Text } from 'react-native';
import Bugsee, { ErrorBoundary } from '@bugsee/react-native';
import { NATIVE_UNAVAILABLE, PlaygroundNative } from '../../modules/playground-native';
import { ActionButton } from '../ui/ActionButton';
import type { Action } from '../ui/action';
import { afterTap } from '../ui/afterTap';
import { Screen } from '../ui/Screen';
import { Section } from '../ui/Section';

// Crash reports are sent when the SDK launches at the next start, and auto-launch is off by default.
const CRASH_CONFIRM =
  'The app will crash. Turn on Setup → Auto-launch first (or tap Home → Launch after reopening) to send the report.';
const reopen = (kind: string) =>
  `Reopen the app: a crash report with a symbolicated ${kind} stack (Release build with symbols uploaded)`;
const jni = Platform.OS === 'android' ? ' (JNI)' : '';

/** Throws now, inside the tap, so ActionButton logs it, rather than later inside the afterTap timer. */
const afterTapNative = (fn: () => void) => {
  if (!PlaygroundNative.available) throw new Error(NATIVE_UNAVAILABLE);
  afterTap(fn);
};

type CrashKind = 'segv' | 'abort' | 'exception' | 'backgroundThread';
const nativeCrash = (kind: CrashKind, label: string): Action => ({
  id: `crash-native-${kind}`,
  label,
  call: `PlaygroundNative.crash('${kind}')`,
  confirm: CRASH_CONFIRM,
  expect: reopen('native'),
  run: () => afterTapNative(() => PlaygroundNative.crash(kind)),
});
const ndkCrash = (kind: 'segv' | 'abort'): Action => ({
  id: `crash-ndk-${kind}`,
  label: `Native crash: ${kind} (NDK)`,
  call: `PlaygroundNative.crashNdk('${kind}')`,
  confirm: CRASH_CONFIRM,
  platforms: ['android'],
  expect: reopen('NDK'),
  run: () => afterTapNative(() => PlaygroundNative.crashNdk(kind)),
});

export const errorsActions: Action[] = [
  {
    id: 'handled-error',
    label: 'Log handled error',
    call: "Bugsee.logException(new Error('Playground handled error'))",
    expect: 'A handled error report with a JS stack',
    run: () => Bugsee.logException(new Error('Playground handled error')),
  },
  {
    id: 'handled-string',
    label: 'Log handled string',
    call: "Bugsee.logException('a plain string')",
    expect: 'A handled error report whose message is the string',
    run: () => Bugsee.logException('a plain string'),
  },
  {
    id: 'handled-labels',
    label: 'Log handled error with labels',
    call: "Bugsee.logException(new Error('labelled'), { labels: ['playground', 'handled'] })",
    knownIssue: 'android-247',
    expect: 'Labels playground, handled on the error',
    run: () => Bugsee.logException(new Error('labelled'), { labels: ['playground', 'handled'] }),
  },
  {
    id: 'handled-domain',
    label: 'Log handled error with domain',
    call: "Bugsee.logException(new Error('domain'), { domain: 'com.bugsee.playground' })",
    expect: 'Domain com.bugsee.playground on the error',
    run: () => Bugsee.logException(new Error('domain'), { domain: 'com.bugsee.playground' }),
  },
  {
    id: 'handled-video-ios',
    label: 'Log handled error with video',
    call: "Bugsee.logException(new Error('video'), { includeVideo: true })",
    platforms: ['ios'],
    knownIssue: 'cocoa-226',
    expect: 'A handled error report that includes video',
    run: () => Bugsee.logException(new Error('video'), { includeVideo: true }),
  },
  {
    id: 'handled-video-android',
    label: 'Log handled error with video',
    call: "Bugsee.logException(new Error('video'), { includeVideo: true })",
    platforms: ['android'],
    knownIssue: 'android-247',
    expect: 'A handled error report that includes video',
    run: () => Bugsee.logException(new Error('video'), { includeVideo: true }),
  },

  {
    id: 'unhandled-api',
    label: 'Log unhandled exception',
    call: "Bugsee.logUnhandledException(new Error('Playground unhandled via API'))",
    expect: 'A crash-type report (iOS: at the next launch)',
    run: () => Bugsee.logUnhandledException(new Error('Playground unhandled via API')),
  },
  {
    id: 'unhandled-rejection',
    label: 'Unhandled promise rejection',
    call: 'global Promise rejection (no catch)',
    expect: 'A crash report from the rejection tracker',
    run: () => {
      void Promise.reject(new Error('Playground unhandled rejection'));
    },
  },

  {
    id: 'js-crash',
    label: 'JS crash',
    call: 'Bugsee.testJsCrash()',
    confirm: CRASH_CONFIRM,
    expect: reopen('JS'),
    run: () => afterTap(() => Bugsee.testJsCrash()),
  },
  {
    id: 'native-crash-sdk',
    label: 'Native crash (SDK test)',
    call: 'Bugsee.testNativeCrash()',
    confirm: CRASH_CONFIRM,
    expect: reopen('native'),
    run: () => afterTap(() => Bugsee.testNativeCrash()),
  },
  nativeCrash('segv', `Native crash: segv${jni}`),
  nativeCrash('abort', `Native crash: abort${jni}`),
  nativeCrash('exception', 'Native crash: exception'),
  nativeCrash('backgroundThread', 'Native crash: background thread'),
  ndkCrash('segv'),
  ndkCrash('abort'),

  {
    id: 'hang',
    label: 'Hang main thread 6 s',
    call: 'PlaygroundNative.hangMainThread(6000)',
    expect: 'UI frozen 6 s; a hang report (detect.hang on)',
    run: () => PlaygroundNative.hangMainThread(6000),
  },
];

const group = (prefixes: string[]) => errorsActions.filter((a) => prefixes.some((p) => a.id.startsWith(p)));
const buttons = (list: Action[]) => list.map((a) => <ActionButton key={a.id} action={a} />);

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error('Playground ErrorBoundary error');
  return <Text>Child renders normally.</Text>;
}

function BoundaryDemo() {
  const [armed, setArmed] = useState(false);
  return (
    <>
      <Text>Expect: The fallback renders; a handled error with label boundary is reported</Text>
      <ErrorBoundary
        options={{ labels: ['boundary'] }}
        fallback={({ error, resetError }) => (
          <>
            <Text>Fallback: {error instanceof Error ? error.message : String(error)}</Text>
            <Button
              title="Reset"
              onPress={() => {
                setArmed(false);
                resetError();
              }}
            />
          </>
        )}
      >
        <Bomb armed={armed} />
      </ErrorBoundary>
      <Button title="Throw inside ErrorBoundary" onPress={() => setArmed(true)} />
    </>
  );
}

export default function ErrorsScreen() {
  return (
    <Screen title="Errors">
      <Section title="Handled">{buttons(group(['handled-']))}</Section>
      <Section title="Unhandled">{buttons(group(['unhandled-']))}</Section>
      <Section title="ErrorBoundary">
        <BoundaryDemo />
      </Section>
      <Section title="Crashes">{buttons(group(['js-crash', 'native-crash', 'crash-']))}</Section>
      <Section title="Hang">{buttons(group(['hang']))}</Section>
    </Screen>
  );
}
