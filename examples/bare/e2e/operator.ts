/**
 * Operator steps (campaign N-18): the few things only a person can do on a
 * handset -- tap Send in the report dialog, shake it, press a hardware
 * combination. The harness prints exactly what to do, waits for the
 * artifact the action produces, and asserts it; the person only taps.
 *
 *   const bundle = await operatorStep(
 *     { id: 'M-A1', device: 'WOD_LX1', timeoutMs: 60_000,
 *       instructions: ['In the Bugsee report dialog, tap the check-mark (Send) at the top right.'] },
 *     async () => (await listBundles()).length > 0 ? (await awaitBundles(1, 1_000))[0] : undefined,
 *   );
 *
 * Gating: a suite runs an operator case only when its platform's variable
 * is `1` (`operatorEnabled`): `E2E_ANDROID_OPERATOR` / `E2E_IOS_OPERATOR`.
 * Nothing in the harness ever taps for the operator.
 *
 * Where the prompt goes, so whoever runs the suite can relay it:
 *   - stdout, framed (`>>> OPERATOR <id> ...`), and stderr, so Jest's own
 *     output and a tee'd log both carry it;
 *   - `E2E_OPERATOR_PROMPT_FILE=<path>`: one JSON line per prompt and per
 *     outcome (`{"event":"prompt"|"done"|"timeout", ...}`), for a controller
 *     tailing it;
 *   - `E2E_OPERATOR_NOTIFY=1`: a macOS notification and a short spoken cue
 *     on this Mac.
 */
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export type OperatorPlatform = 'android' | 'ios';

export interface OperatorStepSpec {
  /** The plan's step id, e.g. `M-A1`. */
  readonly id: string;
  /** Which handset, in words the operator knows (`WOD_LX1`, `iPhone XS`). */
  readonly device: string;
  /** Exactly what to do, one action per line. */
  readonly instructions: readonly string[];
  /** How long the operator has, from the prompt. */
  readonly timeoutMs: number;
}

/** Whether operator cases run for `platform`: its variable is exactly `1`. */
export function operatorEnabled(platform: OperatorPlatform, env: NodeJS.ProcessEnv = process.env): boolean {
  return (platform === 'android' ? env.E2E_ANDROID_OPERATOR : env.E2E_IOS_OPERATOR) === '1';
}

/** The framed prompt, as printed. Pure: unit-tested. */
export function formatPrompt(step: OperatorStepSpec): string {
  const seconds = Math.round(step.timeoutMs / 1000);
  const lines = [
    `>>> OPERATOR ${step.id} on ${step.device} (${seconds} s)`,
    ...step.instructions.map((line, i) => `>>>   ${i + 1}. ${line}`),
    `>>> The harness checks the result itself; nothing else to confirm.`,
  ];
  const width = Math.max(...lines.map(line => line.length));
  const rule = '>'.repeat(Math.min(width, 100));
  return [rule, ...lines, rule].join('\n');
}

function record(event: string, step: OperatorStepSpec, extra: Record<string, unknown> = {}): void {
  const file = process.env.E2E_OPERATOR_PROMPT_FILE;
  if (file === undefined || file === '') {
    return;
  }
  appendFileSync(
    file,
    `${JSON.stringify({ event, id: step.id, device: step.device, instructions: step.instructions, timeoutMs: step.timeoutMs, at: new Date().toISOString(), ...extra })}\n`,
  );
}

function notify(step: OperatorStepSpec): void {
  if (process.env.E2E_OPERATOR_NOTIFY !== '1' || process.platform !== 'darwin') {
    return;
  }
  const text = `${step.id} on ${step.device}: ${step.instructions[0] ?? ''}`.replace(/["\\]/g, "'");
  execFile('osascript', ['-e', `display notification "${text}" with title "Bugsee e2e operator step"`], () => {});
  execFile('say', [`Operator step ${step.id}`], () => {});
}

/** Prints the prompt everywhere it goes (see the top of this file). */
export function operatorPrompt(step: OperatorStepSpec): void {
  const text = formatPrompt(step);
  console.log(text);
  process.stderr.write(`${text}\n`);
  record('prompt', step);
  notify(step);
}

/**
 * Prompts, then polls `until` every `pollMs` until it yields a value (the
 * artifact the action produced) or `step.timeoutMs` passes. Resolves the
 * value; throws on timeout, naming the step and what was asked, so the miss
 * reads as "nobody did it" rather than as a product failure.
 */
export async function operatorStep<T>(
  step: OperatorStepSpec,
  until: () => Promise<T | undefined>,
  pollMs = 1_000,
): Promise<T> {
  operatorPrompt(step);
  const deadline = Date.now() + step.timeoutMs;
  for (;;) {
    const value = await until();
    if (value !== undefined) {
      record('done', step);
      console.log(`>>> OPERATOR ${step.id}: done`);
      return value;
    }
    if (Date.now() >= deadline) {
      record('timeout', step);
      throw new Error(
        `operator step ${step.id} on ${step.device} timed out after ${Math.round(step.timeoutMs / 1000)} s: ` +
          `nothing the step produces appeared. Asked: ${step.instructions.join(' / ')}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}
