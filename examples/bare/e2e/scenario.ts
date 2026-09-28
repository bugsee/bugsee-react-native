/**
 * Runs one named scenario of the example app on the Android handset and
 * captures the device's whole log while it does.
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
 *     per-launch channel. The app prefers the URI when present.
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

import { ADB, ANDROID_PACKAGE, ANDROID_SERIAL } from './device';

const execFileAsync = promisify(execFile);

export const SCENARIO_FILE = join(__dirname, '..', 'e2e-scenario.json');

export interface Scenario {
  readonly scenario: string;
  readonly nonce: string;
}

/** Writes the scenario file for the next launch, with a fresh nonce. */
export function writeScenario(name: string): Scenario {
  const scenario = { scenario: name, nonce: randomBytes(6).toString('hex') };
  writeFileSync(SCENARIO_FILE, `${JSON.stringify(scenario)}\n`);
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
  /ReactNativeJS|Bugsee|AndroidRuntime|FATAL|bareexample|libbugsee|DEBUG\s*:|crashpad/;

/** One logcat line, with the device's own timestamp (epoch ms). */
export interface LogLine {
  readonly index: number;
  readonly deviceMs: number;
  readonly text: string;
}

/**
 * The whole device log (no tag filter: a crash's `AndroidRuntime` lines and
 * the linker/SELinux lines that name loaded `.so` files are not ours to tag),
 * with device-side timestamps so a timing is the device's, not adb's
 * delivery latency.
 */
export class Logcat {
  readonly lines: LogLine[] = [];
  private readonly child: ChildProcess;
  private buffer = '';
  private waiters: Array<() => void> = [];

  private constructor(child: ChildProcess) {
    this.child = child;
    const onChunk = (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      const parts = this.buffer.split('\n');
      this.buffer = parts.pop() ?? '';
      for (const raw of parts) {
        const text = raw.replace(/\r$/, '');
        const stamp = /^\s*(\d+)\.(\d{3})\s/.exec(text);
        const deviceMs = stamp
          ? Number(stamp[1]) * 1000 + Number(stamp[2])
          : Number.NaN;
        this.lines.push({ index: this.lines.length, deviceMs, text });
      }
      const waiters = this.waiters;
      this.waiters = [];
      for (const wake of waiters) {
        wake();
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
  }

  /** Clears the device's buffer, then streams from there. */
  static async start(): Promise<Logcat> {
    await adbStatus('logcat', '-c');
    const child = spawn(ADB, ['-s', ANDROID_SERIAL, 'logcat', '-v', 'epoch']);
    return new Logcat(child);
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

  stop(): void {
    this.child.kill('SIGKILL');
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
