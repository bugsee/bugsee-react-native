/**
 * Runs one named scenario of the example app -- on the Android handset, or
 * on the iOS simulator -- and captures the app's log while it does.
 *
 * How the app learns which scenario to run, with no native code:
 *
 *   - `e2e-scenario.json` next to App.tsx, which Metro serves inside the debug
 *     bundle. The default (`{"scenario":"launch"}`) is written by
 *     scripts/write-credentials.mjs; this module overwrites it per run.
 *   - the launch intent's data URI, `bugsee-e2e://scenario/<name>?nonce=<hex>`,
 *     read through `Linking.getInitialURL()`. A release build has the JSON
 *     baked in at build time, so a scenario that must run on a release build
 *     (a Java crash that a debug build's red box would swallow) needs a
 *     per-launch channel. The app prefers the URI when present. Android only:
 *     the iOS app registers no URL scheme, and on iOS nothing needs a release
 *     build (`testNativeCrash` there is native, so no red box can catch it),
 *     so iOS steers through the JSON alone -- and waits for Metro to serve
 *     the new file before launching (`awaitMetroServes`).
 *
 * Every run carries a fresh nonce, and the app echoes it in its first marker,
 * so a stale bundle, a stale scenario file or a bundle left by an earlier run
 * cannot pass for this one.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  ADB,
  ANDROID_PACKAGE,
  ANDROID_SERIAL,
  IOS_BUNDLE_ID,
  IOS_SIMULATOR_ID,
  IOS_TARGET,
} from './device';

const execFileAsync = promisify(execFile);

export const SCENARIO_FILE = join(__dirname, '..', 'e2e-scenario.json');

export interface Scenario {
  readonly scenario: string;
  readonly nonce: string;
}

/** Fields the JSON channel carries beyond the name and nonce. */
export interface ScenarioExtras {
  /** Replaces the credentials' endpoint (iOS simulator retention, bundles.ts). */
  readonly endpoint?: string;
}

/** Writes the scenario file for the next launch, with a fresh nonce. */
export function writeScenario(name: string, extras: ScenarioExtras = {}): Scenario {
  const scenario = { scenario: name, nonce: randomBytes(6).toString('hex') };
  writeFileSync(SCENARIO_FILE, `${JSON.stringify({ ...scenario, ...extras })}\n`);
  return scenario;
}

/** Puts the file back to what launch.test.ts expects. */
export function resetScenario(): void {
  writeFileSync(SCENARIO_FILE, `${JSON.stringify({ scenario: 'launch' })}\n`);
}

export function scenarioUri({ scenario, nonce }: Scenario): string {
  return `bugsee-e2e://scenario/${scenario}?nonce=${nonce}`;
}

/** Runs adb against the handset under test, returning stdout. */
export async function adb(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(ADB, ['-s', ANDROID_SERIAL, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

/** Like `adb`, but resolves with stdout+stderr and the exit code, never rejects. */
export async function adbStatus(
  ...args: string[]
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      ADB,
      ['-s', ANDROID_SERIAL, ...args],
      { encoding: 'utf8' },
    );
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
    };
  }
}

export async function pidOf(): Promise<string | undefined> {
  const { output } = await adbStatus('shell', 'pidof', ANDROID_PACKAGE);
  const pid = output.trim();
  return pid === '' ? undefined : pid;
}

const RELEVANT =
  /ReactNativeJS|Bugsee|AndroidRuntime|FATAL|bareexample|libbugsee|DEBUG\s*:|crashpad|BUGSEE_E2E|BareExample|Terminating app/;

/** One logcat line, with the device's own timestamp (epoch ms). */
export interface LogLine {
  readonly index: number;
  readonly deviceMs: number;
  readonly text: string;
}

/**
 * Captured log lines, and the waiting and slicing every test does over them.
 * Where the lines come from is the subclass's business: logcat on Android,
 * the launched process's console on the iOS simulator.
 */
export abstract class DeviceLog {
  readonly lines: LogLine[] = [];
  private buffer = '';
  private waiters: Array<() => void> = [];

  /** The device-side time of a line, in epoch ms, or NaN if it carries none. */
  protected abstract stampOf(text: string): number;

  /** Feeds raw output; complete lines are recorded and wake any waiter. */
  protected feed(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    for (const raw of parts) {
      const text = raw.replace(/\r$/, '');
      this.lines.push({ index: this.lines.length, deviceMs: this.stampOf(text), text });
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  /** Where the log is now; pass to `waitFor`/`all` to look only after it. */
  mark(): number {
    return this.lines.length;
  }

  all(pattern: RegExp, from = 0, to = this.lines.length): LogLine[] {
    return this.lines.slice(from, to).filter(line => pattern.test(line.text));
  }

  /**
   * Resolves with the first line at or after `from` matching `pattern`, or
   * undefined when `timeoutMs` passes first. Never rejects: the caller
   * asserts, so the captured log is reportable.
   */
  async waitFor(
    pattern: RegExp,
    timeoutMs: number,
    from = 0,
  ): Promise<LogLine | undefined> {
    const deadline = Date.now() + timeoutMs;
    let scanned = from;
    for (;;) {
      for (; scanned < this.lines.length; scanned += 1) {
        const line = this.lines[scanned]!;
        if (pattern.test(line.text)) {
          return line;
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        return undefined;
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /**
   * The last `count` relevant lines from `from`, for a failure message. The
   * handset logs sensors several times a second; only the app's own tags,
   * crashes and the app's process lifecycle are worth reading.
   */
  tail(from = 0, count = 300): string {
    return this.lines
      .slice(from)
      .filter(line => RELEVANT.test(line.text))
      .slice(-count)
      .map(line => line.text)
      .join('\n');
  }

  abstract stop(): void;
}

/**
 * The whole device log (no tag filter: a crash's `AndroidRuntime` lines and
 * the linker/SELinux lines that name loaded `.so` files are not ours to tag),
 * with device-side timestamps so a timing is the device's, not adb's
 * delivery latency.
 */
export class Logcat extends DeviceLog {
  private readonly child: ChildProcess;

  private constructor(child: ChildProcess) {
    super();
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.feed(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.feed(chunk));
  }

  /** Clears the device's buffer, then streams from there. */
  static async start(): Promise<Logcat> {
    await adbStatus('logcat', '-c');
    const child = spawn(ADB, ['-s', ANDROID_SERIAL, 'logcat', '-v', 'epoch']);
    return new Logcat(child);
  }

  protected stampOf(text: string): number {
    const stamp = /^\s*(\d+)\.(\d{3})\s/.exec(text);
    return stamp ? Number(stamp[1]) * 1000 + Number(stamp[2]) : Number.NaN;
  }

  stop(): void {
    this.child.kill('SIGKILL');
  }
}

/** One launch of the app on the simulator, attached to its console. */
export interface SimulatorLaunch {
  /** Log index this launch's output starts at. */
  readonly start: number;
  /**
   * Settles when the console stream ends -- which it does only when the
   * process does -- with the launcher's exit code.
   */
  readonly ended: Promise<number | null>;
  /** Whether the stream has ended yet. */
  readonly hasEnded: () => boolean;
}

/**
 * The iOS simulator app's stdout/stderr, across every launch in a test file.
 *
 * `simctl launch --console-pty` attaches to one process only, so each launch
 * spawns its own attachment and appends to the same line list; a crashed
 * launch's stream simply ends. `NSLog` lines (the SDK's and the bridge's,
 * `BugseeRN report handler ...`) carry the simulator's wall clock, to the
 * millisecond, which is the timing source; RN's mirrored `console.log` lines
 * (the `BUGSEE_E2E` markers) carry none.
 *
 * `--console-pty`, not `--console`: simctl only streams the app's stdout when
 * it allocates a pty (see device.ts).
 */
export class SimulatorConsole extends DeviceLog {
  private readonly children = new Set<ChildProcess>();

  static start(): SimulatorConsole {
    if (IOS_TARGET !== 'simulator') {
      throw new Error(
        'the iOS report-handler e2e drives the simulator only (retention and ' +
          'bundle pulls are simulator-side): set E2E_IOS_TARGET=simulator',
      );
    }
    return new SimulatorConsole();
  }

  /** `2026-09-28 20:36:59.505 BareExample[95747:11510203] ...`, local time. */
  protected stampOf(text: string): number {
    const stamp = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})\d*(?:[+-]\d{4})? \S+\[\d+:/.exec(
      text,
    );
    return stamp ? new Date(`${stamp[1]}T${stamp[2]}`).getTime() : Number.NaN;
  }

  /**
   * Starts the app fresh on the scenario already written to the JSON:
   * `--terminate-running-process`, as `force-stop` on Android, because
   * launching a running app only resumes it.
   */
  launch(): SimulatorLaunch {
    const start = this.mark();
    const child = spawn('xcrun', [
      'simctl',
      'launch',
      '--console-pty',
      '--terminate-running-process',
      IOS_SIMULATOR_ID,
      IOS_BUNDLE_ID,
    ]);
    this.children.add(child);
    child.stdout?.on('data', (chunk: Buffer) => this.feed(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.feed(chunk));
    let over = false;
    const ended = new Promise<number | null>(resolve => {
      child.on('close', code => {
        over = true;
        this.children.delete(child);
        resolve(code);
      });
      child.on('error', () => {
        over = true;
        this.children.delete(child);
        resolve(null);
      });
    });
    return { start, ended, hasEnded: () => over };
  }

  stop(): void {
    for (const child of this.children) {
      child.kill('SIGKILL');
    }
    this.children.clear();
  }
}

/**
 * Starts the app fresh on `scenario`. force-stop first: `am start` on an
 * already-running app resumes it without re-running JS.
 */
export async function launchScenario(scenario: Scenario): Promise<void> {
  await adb('shell', 'am', 'force-stop', ANDROID_PACKAGE);
  await adb(
    'shell',
    'am',
    'start',
    '-n',
    `${ANDROID_PACKAGE}/.MainActivity`,
    '-a',
    'android.intent.action.VIEW',
    '-d',
    `'${scenarioUri(scenario)}'`,
  );
}

/**
 * Waits until Metro serves a bundle carrying `nonce`, so an iOS launch cannot
 * pick up the previous scenario file: Metro rebuilds on its file watcher, a
 * beat after the write. (Android steers through the launch URI instead.)
 */
export async function awaitMetroServes(nonce: string, timeoutMs = 60_000): Promise<void> {
  const url = 'http://localhost:8081/index.bundle?platform=ios&dev=true&minify=false';
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (body.includes(nonce)) {
        return;
      }
      last = `HTTP ${response.status}, ${body.length} bytes without the nonce`;
    } catch (error) {
      last = String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Metro never served a bundle carrying nonce ${nonce} (last: ${last}); is it running?`);
}

/** Whether a host process is alive: simulator apps are host processes. */
export function hostProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
