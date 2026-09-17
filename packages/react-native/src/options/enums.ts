/**
 * The option enums, as the numbers that cross the bridge.
 *
 * These are each enum's INTERNAL VALUE, not its ordinal. The two diverge on
 * four of the five — Error is value 1 at ordinal 0, Fullscreen is value 20 at
 * ordinal 3 — and only VideoQuality coincides. iOS consumes these numbers
 * directly; the Android bridge converts them with each enum's own
 * fromIntValue/fromRawValue, never values()[n].
 *
 * Verified against the SDK sources, not the design doc: an earlier reading of
 * VideoMode with a regex that excluded digits dropped V1 and V2 and made
 * Fullscreen look like ordinal 1.
 */

export const LogLevel = {
  Error: 1,
  Warning: 2,
  Info: 3,
  Debug: 4,
  Verbose: 5,
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const VideoMode = {
  None: 0,
  V1: 1,
  V2: 2,
  Fullscreen: 20,
  DirectBuffers: 21,
} as const;
export type VideoMode = (typeof VideoMode)[keyof typeof VideoMode];

export const VideoQuality = {
  Default: 0,
  Medium: 1,
  High: 2,
} as const;
export type VideoQuality = (typeof VideoQuality)[keyof typeof VideoQuality];

export const FrameRate = {
  Low: 1,
  Medium: 2,
  High: 3,
  Raw: 4,
} as const;
export type FrameRate = (typeof FrameRate)[keyof typeof FrameRate];

export const IssueSeverity = {
  VeryLow: 1,
  Medium: 2,
  High: 3,
  Critical: 4,
  Blocker: 5,
} as const;
export type IssueSeverity = (typeof IssueSeverity)[keyof typeof IssueSeverity];
