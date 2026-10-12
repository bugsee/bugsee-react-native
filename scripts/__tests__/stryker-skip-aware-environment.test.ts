/**
 * The scripts mutation run's jest environment, wrapped the way Stryker wraps
 * it (`mixinJestEnvironment`, which keeps our `handleTestEvent` and calls it
 * from its own handler), so the receiver is the one Stryker gives it.
 */
import { mixinJestEnvironment } from '@stryker-mutator/jest-runner';

const SkipAwareEnvironment = require('../stryker-skip-aware-environment.js');

type Env = {
  global: Record<string, unknown>;
  handleTestEvent(event: { name: string; test?: unknown }, state: unknown): Promise<void> | void;
  teardown(): Promise<void>;
};

function wrapped(): Env {
  const Wrapped = mixinJestEnvironment(SkipAwareEnvironment) as unknown as new (config: unknown, context: unknown) => Env;
  return new Wrapped(
    { globalConfig: {}, projectConfig: { testEnvironmentOptions: {} } },
    { console, docblockPragmas: {}, testPath: __filename },
  );
}

describe('the skip-aware Stryker environment', () => {
  it.each(['test_skip', 'test_todo'])('clears the current test id on %s', async (name) => {
    const env = wrapped();
    const context = env.global.__stryker__ as { currentTestId?: string };
    context.currentTestId = 'a skipped test';
    await env.handleTestEvent({ name }, {});
    expect(context.currentTestId).toBeUndefined();
    await env.teardown();
  });

  it('leaves the id alone on other events', async () => {
    const env = wrapped();
    const context = env.global.__stryker__ as { currentTestId?: string };
    context.currentTestId = 'a running test';
    await env.handleTestEvent({ name: 'test_started' }, {});
    expect(context.currentTestId).toBe('a running test');
    await env.teardown();
  });
});
