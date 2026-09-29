/**
 * Runs one named scenario of the example app -- on the Android handset, or
 * on iOS (the simulator or an iPhone) -- and captures the app's log while it does.
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
 *     the iOS app registers no URL scheme.
 *   - iOS: the launch arguments `-bugseeE2eScenario <name> -bugseeE2eNonce
 *     <hex> -bugseeE2eEndpoint <url>` (`scenarioArgs`), which iOS puts in
 *     NSUserDefaults' volatile argument domain and the app reads through
 *     `Settings`. A physical iPhone's Debug app runs its embedded bundle --
 *     JSON baked in at build time -- whenever it cannot reach Metro (a fresh
 *     install has no Local Network permission), so the JSON alone cannot
 *     steer it. Every iOS launch passes them, simulator and iPhone alike; the
 *     simulator also still waits for Metro to serve the new JSON
 *     (`awaitMetroServes`), since its app always loads from Metro.
 *
 * Every run carries a fresh nonce, and the app echoes it in its first marker,
 * so a stale bundle, a stale scenario file or a bundle left by an earlier run
 * cannot pass for this one.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  ADB,
  ANDROID_PACKAGE,
  ANDROID_SERIAL,
  IOS_BUNDLE_ID,
  IOS_SIMULATOR_ID,
  iosTarget,
  requireVerifiedIosDevice,
  verifyIosDevice,
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

/**
 * The iOS per-launch channel: launch arguments App.tsx reads back through
 * `Settings` (NSUserDefaults' argument domain). Volatile -- a later launch
 * that is not given them falls back to the JSON.
 */
export function scenarioArgs({ scenario, nonce }: Scenario, extras: ScenarioExtras = {}): string[] {
  return [
    '-bugseeE2eScenario',
    scenario,
    '-bugseeE2eNonce',
    nonce,
    ...(extras.endpoint === undefined ? [] : ['-bugseeE2eEndpoint', extras.endpoint]),
  ];
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
  /** Partial last lines, per stream: two attachments must not splice lines. */
  private readonly buffers = new Map<unknown, string>();
  private waiters: Array<() => void> = [];

  /** The device-side time of a line, in epoch ms, or NaN if it carries none. */
  protected abstract stampOf(text: string): number;

  /**
   * Feeds raw output from `source` (one stream); complete lines are recorded
   * and wake any waiter. Returns the lines this chunk completed.
   */
  protected feed(chunk: Buffer, source: unknown = this): LogLine[] {
    const parts = ((this.buffers.get(source) ?? '') + chunk.toString('utf8')).split('\n');
    this.buffers.set(source, parts.pop() ?? '');
    const added: LogLine[] = [];
    for (const raw of parts) {
      const text = raw.replace(/\r$/, '');
      const line = { index: this.lines.length, deviceMs: this.stampOf(text), text };
      this.lines.push(line);
      added.push(line);
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) {
      wake();
    }
    return added;
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

/** One launch of the iOS app, attached to its console. */
export interface IosLaunch {
  /** Log index this launch's output starts at. */
  readonly start: number;
  /**
   * Settles when the console stream ends -- which it does only when the
   * process does -- with the launcher's exit code.
   */
  readonly ended: Promise<number | null>;
  /** Whether the stream has ended yet. */
  readonly hasEnded: () => boolean;
  /**
   * This attachment's own lines, in order. On an iPhone its last line is
   * devicectl's `App terminated due to signal <n>.`: which process died, and
   * of what, comes from here rather than from a neighbouring launch's stream.
   */
  readonly output: readonly LogLine[];
}

/**
 * The iOS app's stdout/stderr, across every launch in a test file -- on the
 * simulator or on a physical iPhone (`E2E_IOS_TARGET`, device.ts; the
 * iPhone only from device.ts's allowlist, identity-checked first).
 *
 * A console attachment follows one process only, so each launch spawns its
 * own and appends to the same line list; a crashed launch's stream simply
 * ends. `NSLog` lines (the SDK's and the bridge's, `BugseeRN report handler
 * ...`) carry the device's wall clock, to the millisecond, and the
 * `BareExample[<pid>:<tid>]` prefix -- the timing source and the thread
 * witness, and both survive devicectl's console relay unchanged. RN's
 * mirrored `console.log` lines (the `BUGSEE_E2E` markers) carry neither.
 */
export abstract class IosConsole extends DeviceLog {
  protected readonly children = new Set<ChildProcess>();

  /**
   * The console for the configured target, which must be stated exactly
   * (`E2E_IOS_TARGET=simulator|device`): anything else throws here.
   */
  static start(): IosConsole {
    switch (iosTarget()) {
      case 'simulator':
        return new SimulatorConsole();
      case 'device':
        return new DeviceConsole();
    }
  }

  /** `2026-09-28 20:36:59.505 BareExample[95747:11510203] ...`, local time. */
  protected stampOf(text: string): number {
    const stamp = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})\d*(?:[+-]\d{4})? \S+\[\d+:/.exec(
      text,
    );
    return stamp ? new Date(`${stamp[1]}T${stamp[2]}`).getTime() : Number.NaN;
  }

  /** The launcher: a fresh process, with `args` as the app's arguments. */
  protected abstract spawnLaunch(args: readonly string[]): ChildProcess;

  /**
   * Starts the app fresh, terminating a running instance first (as
   * `force-stop` on Android: launching a running app only resumes it), with
   * `args` as its launch arguments (`scenarioArgs`).
   */
  launch(args: readonly string[] = []): IosLaunch {
    const start = this.mark();
    const child = this.spawnLaunch(args);
    this.children.add(child);
    const output: LogLine[] = [];
    const take = (chunk: Buffer) => {
      output.push(...this.feed(chunk, child));
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
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
    return { start, ended, hasEnded: () => over, output };
  }
}

/**
 * `simctl launch --console-pty`, not `--console`: simctl only streams the
 * app's stdout when it allocates a pty (see device.ts).
 */
export class SimulatorConsole extends IosConsole {
  protected spawnLaunch(args: readonly string[]): ChildProcess {
    return spawn('xcrun', [
      'simctl',
      'launch',
      '--console-pty',
      '--terminate-running-process',
      IOS_SIMULATOR_ID,
      IOS_BUNDLE_ID,
      ...args,
    ]);
  }

  stop(): void {
    for (const child of this.children) {
      child.kill('SIGKILL');
    }
    this.children.clear();
  }
}

/**
 * A physical iPhone: `devicectl device process launch --console`, which
 * connects the app's standard streams to its own and waits for the app to
 * exit, then prints `App terminated due to signal <n>.` -- the process-death
 * evidence on hardware, where there is no host process to probe. `--` ends
 * devicectl's own options, so the app's `-bugseeE2e...` arguments reach it.
 */
export class DeviceConsole extends IosConsole {
  /** Throws unless `verifyIosDevice()` has passed (harness.ts awaits it). */
  protected spawnLaunch(args: readonly string[]): ChildProcess {
    return spawn('xcrun', [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      requireVerifiedIosDevice(),
      '--console',
      '--terminate-existing',
      IOS_BUNDLE_ID,
      '--',
      ...args,
    ]);
  }

  /**
   * SIGTERM, not SIGKILL: devicectl forwards a catchable signal to the app,
   * so stopping the console also stops the app rather than orphaning it.
   */
  stop(): void {
    for (const child of this.children) {
      child.kill('SIGTERM');
    }
    this.children.clear();
  }
}

/** devicectl's own `App terminated due to signal <n>.` line, parsed. */
export function deviceTerminationSignal(output: readonly LogLine[]): number | undefined {
  for (let i = output.length - 1; i >= 0; i -= 1) {
    const match = /^App terminated due to signal (\d+)\.?$/.exec(output[i]!.text.trim());
    if (match !== null) {
      return Number(match[1]);
    }
  }
  return undefined;
}

/**
 * Runs `devicectl device <args> --device <the iPhone>` and returns its JSON
 * result (devicectl's only stable machine interface is `--json-output`).
 * Always the configured, allowlisted and identity-checked iPhone, by id:
 * never a device picked by default.
 */
export async function devicectl(...args: string[]): Promise<Record<string, unknown>> {
  const device = await verifyIosDevice();
  const dir = mkdtempSync(join(tmpdir(), 'bugsee-devicectl-'));
  const out = join(dir, 'result.json');
  try {
    try {
      await execFileAsync(
        'xcrun',
        ['devicectl', 'device', ...args, '--device', device, '--quiet', '--json-output', out],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        `devicectl device ${args.join(' ')} failed:\n${e.stderr ?? ''}${e.stdout ?? ''}${e.message ?? ''}`,
        { cause: error },
      );
    }
    const parsed = JSON.parse(readFileSync(out, 'utf8')) as { result?: Record<string, unknown> };
    return parsed.result ?? {};
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The iPhone's running BareExample processes' pids. */
export async function devicePidsOfApp(): Promise<number[]> {
  const result = await devicectl('info', 'processes');
  const processes = (result.runningProcesses ?? []) as Array<{
    executable?: string;
    processIdentifier?: number;
  }>;
  return processes
    .filter(p => /\/BareExample\.app\/BareExample$/.test(p.executable ?? ''))
    .map(p => p.processIdentifier!)
    .filter(pid => typeof pid === 'number');
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
