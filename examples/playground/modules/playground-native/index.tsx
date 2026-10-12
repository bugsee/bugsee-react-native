import { requireOptionalNativeModule, requireNativeViewManager } from 'expo-modules-core';
import React from 'react';
import { Platform, Text } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export type CrashKind = 'segv' | 'abort' | 'exception' | 'backgroundThread';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface NativeShape {
  crash(kind: CrashKind): void;
  crashNdk(kind: 'segv' | 'abort'): void;
  hangMainThread(ms: number): void;
  log(level: LogLevel, message: string): void;
  request(method: string, url: string, body: string | null): Promise<{ status: number; body: string }>;
}

const native = requireOptionalNativeModule<NativeShape>('PlaygroundNative');
export const NATIVE_UNAVAILABLE = 'native module unavailable (Expo Go or a missing dev build)';
const UNAVAILABLE = NATIVE_UNAVAILABLE;
const fail = (): never => { throw new Error(UNAVAILABLE); };

export const PlaygroundNative = {
  available: native !== null,
  supportsNdk: native !== null && Platform.OS === 'android',
  crash: (kind: CrashKind) => (native ? native.crash(kind) : fail()),
  crashNdk: (kind: 'segv' | 'abort') => (native ? native.crashNdk(kind) : fail()),
  hangMainThread: (ms: number) => (native ? native.hangMainThread(ms) : fail()),
  log: (level: LogLevel, message: string) => (native ? native.log(level, message) : fail()),
  request: (method: string, url: string, body?: string) =>
    native ? native.request(method, url, body ?? null) : Promise.reject(new Error(UNAVAILABLE)),
};

let NativeView: React.ComponentType<{ style?: StyleProp<ViewStyle> }> | null = null;
try {
  NativeView = native ? requireNativeViewManager('PlaygroundNative') : null;
} catch {
  NativeView = null;
}

export function NativeSecureField(props: { style?: StyleProp<ViewStyle> }) {
  return NativeView ? <NativeView style={[{ height: 100 }, props.style]} /> : <Text>{UNAVAILABLE}</Text>;
}
