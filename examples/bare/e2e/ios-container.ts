/**
 * Reads and edits of the iPhone app's data container beyond what bundles.ts
 * needs, for the crash-recovery stress suite (campaign N-17,
 * ios-recovery-stress.test.ts) -- committed from the cocoa-191b probe
 * (cocoa-191b-results.md, experiment E1).
 *
 * Always the allowlisted, identity-checked iPhone (scenario.ts `devicectl`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IOS_BUNDLE_ID } from './device';
import { devicectl } from './scenario';

const CONTAINER = ['--domain-type', 'appDataContainer', '--domain-identifier', IOS_BUNDLE_ID];
const CRASH_QUEUE = 'Library/Caches/com.bugsee.crashreporter';

/** PLCrashReporter's queue as `<relative path>:<size>`; `[]` when it does not exist. */
export async function crashQueue(): Promise<string[]> {
  try {
    const result = await devicectl('info', 'files', ...CONTAINER, '--subdirectory', CRASH_QUEUE);
    return ((result.files ?? []) as Array<Record<string, unknown>>)
      .filter(file => file.isDirectory !== true)
      .map(file => `${String(file.relativePath ?? file.name)}:${String(file.size ?? '')}`);
  } catch (error) {
    if (/failed to get a list of files/.test(String(error))) {
      return [];
    }
    throw error;
  }
}

/** Whether `queue` (from `crashQueue`) holds a crash report not yet claimed. */
export function holdsReport(queue: readonly string[]): boolean {
  return queue.some(file => /\.plcrash:/.test(file));
}

/** Whether `queue` holds the build record bugsee-cocoa #194 writes next to the reports. */
export function holdsBuildRecord(queue: readonly string[]): boolean {
  return queue.some(file => /bugsee_build\.plist:/.test(file));
}

export interface PrefsState {
  readonly exists: boolean;
  /** `bugsee_lastLaunchSDKVersionKey`, `<absent>` when the file has no such key. */
  readonly sdk?: string;
  /** `bugsee_lastLaunchAppVersionKey`. */
  readonly app?: string;
}

/** The app's preferences plist as it is on disk (cfprefsd may hold newer values). */
export async function prefsState(): Promise<PrefsState> {
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-prefs-'));
  const dest = join(dir, 'prefs.plist');
  try {
    try {
      await devicectl('copy', 'from', ...CONTAINER, '--source', `Library/Preferences/${IOS_BUNDLE_ID}.plist`, '--destination', dest);
    } catch {
      return { exists: false };
    }
    if (!existsSync(dest)) {
      return { exists: false };
    }
    const get = (key: string): string => {
      try {
        return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', dest], { encoding: 'utf8' }).trim();
      } catch {
        return '<absent>';
      }
    };
    return { exists: true, sdk: get('bugsee_lastLaunchSDKVersionKey'), app: get('bugsee_lastLaunchAppVersionKey') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The prefs-loss mode (cocoa-191b E1 `wipe`): copy off everything in the
 * container except Library/Preferences, wipe the whole container the way the
 * harness does (devicectl cannot remove one file), and copy it all back. The
 * crash report and the SDK's data survive; the preferences domain is lost the
 * way a harness wipe loses it. Returns what was saved and restored.
 */
export async function wipeAllButPreferences(): Promise<{ saved: string[]; restored: string[] }> {
  const local = mkdtempSync(join(tmpdir(), 'bugsee-container-save-'));
  try {
    const library = ((await devicectl('info', 'files', ...CONTAINER, '--subdirectory', 'Library')).files ?? []) as Array<
      Record<string, unknown>
    >;
    const top = library
      .map(file => String(file.relativePath ?? file.name ?? '').replace(/\/+$/, ''))
      .filter(name => name !== '' && !name.includes('/'));
    const wanted = ['Documents', ...top.filter(name => name !== 'Preferences').map(name => `Library/${name}`)];
    const saved: string[] = [];
    for (const dir of wanted) {
      try {
        await devicectl('copy', 'from', ...CONTAINER, '--source', dir, '--destination', join(local, dir.replace(/\//g, '__')));
        saved.push(dir);
      } catch {
        // Not every standard directory exists in every container.
      }
    }
    const empty = mkdtempSync(join(tmpdir(), 'bugsee-empty-'));
    try {
      await devicectl('copy', 'to', ...CONTAINER, '--source', empty, '--destination', 'tmp', '--remove-existing-content', 'true');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const restored: string[] = [];
    for (const dir of saved) {
      const source = join(local, dir.replace(/\//g, '__'));
      if (!existsSync(source)) {
        continue;
      }
      await devicectl('copy', 'to', ...CONTAINER, '--source', source, '--destination', dir);
      restored.push(dir);
    }
    return { saved, restored };
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
}
