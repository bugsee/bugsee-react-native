/**
 * What the campaign API scenarios (PREP-api: N-02..N-09, N-11, N-13, N-14)
 * share: the marker prefix, a delay, and the context App.tsx hands them.
 *
 * Every marker is `BUGSEE_E2E api <what> nonce=<n> ...`, so the e2e matches
 * this run's lines only.
 */
import Bugsee, { type LaunchOptions } from '@bugsee/react-native';

/** What App.tsx gives a scenario that has to launch, relaunch or render. */
export interface ApiContext {
  /** The app token App.tsx would launch with. */
  readonly token: string;
  /** App.tsx's launch payload for this scenario (endpoint, duration=90, overrides). */
  readonly options: () => LaunchOptions;
  /** Mounts the scenario's stage (scenarios/api.tsx `ApiStage`). */
  readonly setStage: (stage: ApiStageState | undefined) => void;
}

/** What `ApiStage` renders: the scenario, its nonce, and a step it is at. */
export interface ApiStageState {
  readonly scenario: string;
  readonly nonce: string;
  readonly step: string;
}

export function mark(message: string): void {
  console.log(`BUGSEE_E2E api ${message}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** `error`'s class name, `code` and message, for a marker. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return JSON.stringify({ name: error.name, code: code ?? null, message: error.message });
  }
  return JSON.stringify({ thrown: String(error) });
}

/** Runs `fn`, and says how it settled, without letting it throw. */
export async function settle(fn: () => unknown): Promise<string> {
  try {
    const value = await fn();
    return JSON.stringify({ ok: true, value: value === undefined ? null : value });
  } catch (error) {
    return JSON.stringify({ ok: false, error: JSON.parse(describeError(error)) as unknown });
  }
}

/** Every lifecycle event a scenario subscribed for, in order, `<name>[:<id>]`. */
export function recordEvents(nonce: string, tag: string): string[] {
  const seen: string[] = [];
  Bugsee.onLifecycleEvent(event => {
    const id = event.reportId ?? '';
    seen.push(id === '' ? event.name : `${event.name}:${id}`);
    mark(`${tag} event nonce=${nonce} name=${event.name} report=${id === '' ? '-' : id}`);
  });
  return seen;
}
