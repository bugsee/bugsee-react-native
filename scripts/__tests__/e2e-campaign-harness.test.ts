/**
 * The campaign harness pieces that need no device (N-01, N-12, N-18): the
 * app-under-test parameters, the smoke root switch, the HTTP stub's routes
 * and server, the operator prompt, and the new e2e-native JS guards.
 */
const native = {
  blockMain: jest.fn(async () => undefined),
  nativeLog: jest.fn(),
  rctLog: jest.fn(),
  setFlagSecure: jest.fn(async () => true),
};
jest.mock('../../examples/e2e-native/src/NativeBugseeE2E', () => ({ __esModule: true, default: native }));

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseAndroidActivity,
  parseAndroidAppId,
  parseAppDir,
  parseIosBundleId,
  parseIosExecutable,
} from '../../examples/bare/e2e/device';
import { formatPrompt, operatorEnabled, operatorStep } from '../../examples/bare/e2e/operator';
import { scenarioArgs, smokeRoot } from '../../examples/bare/e2e/scenario';
import { lanAddress, routeOf, startStubServer } from '../../examples/bare/e2e/stub-server';
import { BLOCK_MAIN_MAX_MS, LOG_MESSAGE_MAX, blockMain, nativeLog, rctLog, setFlagSecure } from '../../examples/e2e-native/src';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the app under test (E2E_APP_ID, E2E_IOS_BUNDLE_ID, ...)', () => {
  it('defaults to examples/bare', () => {
    expect(parseAndroidAppId(undefined)).toBe('com.bareexample');
    expect(parseAndroidActivity(undefined)).toBe('.MainActivity');
    expect(parseIosBundleId(undefined)).toBe('org.reactjs.native.example.BareExample');
    expect(parseIosExecutable(undefined)).toBe('BareExample');
    expect(parseAppDir(undefined, '/fallback')).toBe('/fallback');
    expect(parseAppDir('', '/fallback')).toBe('/fallback');
  });

  it('accepts a generated app', () => {
    expect(parseAndroidAppId('com.bugsee.rn083')).toBe('com.bugsee.rn083');
    expect(parseAndroidActivity('com.example.app.MainActivity')).toBe('com.example.app.MainActivity');
    expect(parseIosBundleId('org.reactjs.native.example.Rn083-App')).toBe('org.reactjs.native.example.Rn083-App');
    expect(parseIosExecutable('Rn083')).toBe('Rn083');
  });

  it.each([
    [parseAndroidAppId, 'E2E_APP_ID', 'bareexample'],
    [parseAndroidAppId, 'E2E_APP_ID', 'com.bare example'],
    [parseAndroidAppId, 'E2E_APP_ID', '1com.x'],
    [parseAndroidActivity, 'E2E_ANDROID_ACTIVITY', 'MainActivity'],
    [parseAndroidActivity, 'E2E_ANDROID_ACTIVITY', '.Main Activity'],
    [parseIosBundleId, 'E2E_IOS_BUNDLE_ID', 'nodots'],
    [parseIosBundleId, 'E2E_IOS_BUNDLE_ID', 'a..b'],
    [parseIosExecutable, 'E2E_IOS_EXECUTABLE', ''],
    [parseIosExecutable, 'E2E_IOS_EXECUTABLE', 'a/b'],
  ] as const)('%p refuses %p=%p, naming the variable', (parse, name, raw) => {
    expect(() => parse(raw)).toThrow(`${name} is not a valid value: ${JSON.stringify(raw)}`);
  });

  it('E2E_APP_DIR must hold a package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-dir-'));
    try {
      expect(() => parseAppDir(dir)).toThrow(/E2E_APP_DIR=.*: no package\.json at /);
      writeFileSync(join(dir, 'package.json'), '{}');
      expect(parseAppDir(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('E2E_SMOKE_ROOT and the stub launch argument', () => {
  it('reads 1 as on, unset/empty/0 as off, and refuses anything else', () => {
    expect(smokeRoot('1')).toBe(true);
    for (const raw of [undefined, '', '0']) {
      expect(smokeRoot(raw)).toBe(false);
    }
    expect(() => smokeRoot('yes')).toThrow('E2E_SMOKE_ROOT must be "1" or "0", got "yes"');
  });

  it('passes the stub URL to iOS as -bugseeE2eStub', () => {
    const args = scenarioArgs({ scenario: 'infra-stub', nonce: 'ab' }, { stub: 'http://10.0.0.2:5555' });
    expect(args.slice(0, 6)).toEqual(['-bugseeE2eScenario', 'infra-stub', '-bugseeE2eNonce', 'ab', '-bugseeE2eStub', 'http://10.0.0.2:5555']);
    expect(scenarioArgs({ scenario: 's', nonce: 'n' })).not.toContain('-bugseeE2eStub');
  });
});

describe('the HTTP stub', () => {
  it.each([
    ['/status/500', 500],
    ['/status/200/infra-ab?x=1', 200],
    ['/status/404', 404],
    ['/status/099', 400],
    ['/status/600', 400],
    ['/nothing', 404],
    ['/status/20', 404],
  ])('%p answers %p', (path, status) => {
    expect(routeOf('GET', path, {}, '').status).toBe(status);
  });

  it('delays a status route, up to 30 s', () => {
    expect(routeOf('GET', '/delay/250/status/503/x', {}, '')).toEqual({
      status: 503,
      delayMs: 250,
      body: JSON.stringify({ status: 503, path: '/status/503/x' }),
      contentType: 'application/json',
    });
    expect(routeOf('GET', '/delay/30001/status/200', {}, '').status).toBe(400);
    expect(routeOf('GET', '/delay/30000/status/200', {}, '').delayMs).toBe(30_000);
  });

  it('echoes the request and sizes a body', () => {
    expect(JSON.parse(routeOf('POST', '/echo/a', { h: 'v' }, 'b').body)).toEqual({ method: 'POST', path: '/echo/a', headers: { h: 'v' }, body: 'b' });
    expect(routeOf('GET', '/echo', {}, '').status).toBe(200);
    const bytes = routeOf('GET', '/bytes/5', {}, '');
    expect(bytes).toEqual({ status: 200, delayMs: 0, body: 'xxxxx' });
    expect(routeOf('GET', `/bytes/${10 * 1024 * 1024 + 1}`, {}, '').status).toBe(400);
  });

  it('serves on loopback and records every request', async () => {
    const server = await startStubServer();
    try {
      expect(server.host).toBe('127.0.0.1');
      const waiting = server.waitFor(/^\/status\/503\//, 5_000);
      const response = await fetch(`http://127.0.0.1:${server.port}/status/503/abc`, { method: 'POST', body: 'payload' });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 503, path: '/status/503/abc' });
      const seen = await waiting;
      expect(seen).toEqual(expect.objectContaining({ method: 'POST', path: '/status/503/abc', body: 'payload', status: 503 }));
      expect(await server.waitFor(/never/, 50)).toBeUndefined();
      expect(await server.waitFor(/abc/, 50, 1)).toBeUndefined();
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('picks en0 first for the LAN address, and skips internal and IPv6 entries', () => {
    const entry = (address: string, family: 'IPv4' | 'IPv6', internal = false) =>
      ({ address, family, internal, netmask: '', mac: '', cidr: null }) as never;
    expect(lanAddress({ lo0: [entry('127.0.0.1', 'IPv4', true)], en5: [entry('10.0.0.5', 'IPv4')], en0: [entry('fe80::1', 'IPv6'), entry('192.168.1.7', 'IPv4')] })).toBe('192.168.1.7');
    expect(lanAddress({ en5: [entry('10.0.0.5', 'IPv4')], bridge0: [entry('10.0.0.9', 'IPv4')] })).toBe('10.0.0.9');
    expect(lanAddress({ lo0: [entry('127.0.0.1', 'IPv4', true)] })).toBeUndefined();
  });
});

describe('operator steps', () => {
  const step = { id: 'M-A1', device: 'Android WOD_LX1', instructions: ['Tap Send.', 'Then wait.'], timeoutMs: 90_000 };

  it('runs only when the platform variable is exactly 1', () => {
    expect(operatorEnabled('android', { E2E_ANDROID_OPERATOR: '1' })).toBe(true);
    expect(operatorEnabled('android', { E2E_IOS_OPERATOR: '1' })).toBe(false);
    expect(operatorEnabled('ios', { E2E_IOS_OPERATOR: '1' })).toBe(true);
    expect(operatorEnabled('ios', { E2E_IOS_OPERATOR: 'true' })).toBe(false);
  });

  it('frames the prompt with the step, the device, the time and numbered actions', () => {
    const text = formatPrompt(step);
    const lines = text.split('\n');
    expect(lines[1]).toBe('>>> OPERATOR M-A1 on Android WOD_LX1 (90 s)');
    expect(lines[2]).toBe('>>>   1. Tap Send.');
    expect(lines[3]).toBe('>>>   2. Then wait.');
    expect(lines[0]).toMatch(/^>+$/);
    expect(lines[lines.length - 1]).toBe(lines[0]);
  });

  it('resolves the artifact once it appears, and records prompt and outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-'));
    const file = join(dir, 'prompts.jsonl');
    process.env.E2E_OPERATOR_PROMPT_FILE = file;
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let polls = 0;
      const value = await operatorStep({ ...step, timeoutMs: 2_000 }, async () => (++polls >= 3 ? 'bundle' : undefined), 10);
      expect(value).toBe('bundle');
      await expect(operatorStep({ ...step, timeoutMs: 30 }, async () => undefined, 10)).rejects.toThrow(
        'operator step M-A1 on Android WOD_LX1 timed out after 0 s: nothing the step produces appeared. Asked: Tap Send. / Then wait.',
      );
      const events = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line).event);
      expect(events).toEqual(['prompt', 'done', 'prompt', 'timeout']);
      expect(log.mock.calls.some(call => String(call[0]).includes('>>> OPERATOR M-A1 on'))).toBe(true);
    } finally {
      delete process.env.E2E_OPERATOR_PROMPT_FILE;
      log.mockRestore();
      err.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bugsee-e2e-native campaign helpers (N-12)', () => {
  it('blockMain passes an integer from 0 to 60000 through', async () => {
    await blockMain(0);
    await blockMain(BLOCK_MAIN_MAX_MS);
    expect(native.blockMain.mock.calls).toEqual([[0], [60_000]]);
  });

  it.each([[-1], [60_001], [1.5], [Number.NaN], ['100'], [undefined]])('blockMain refuses %p before crossing', ms => {
    expect(() => blockMain(ms as never)).toThrow('blockMain: ms must be an integer from 0 to 60000');
    expect(native.blockMain).not.toHaveBeenCalled();
  });

  it('nativeLog and rctLog pass each allowed level through', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      nativeLog(level, `m ${level}`);
    }
    for (const level of ['trace', 'info', 'warn', 'error'] as const) {
      rctLog(level, `r ${level}`);
    }
    expect(native.nativeLog.mock.calls).toEqual([['debug', 'm debug'], ['info', 'm info'], ['warn', 'm warn'], ['error', 'm error']]);
    expect(native.rctLog.mock.calls).toEqual([['trace', 'r trace'], ['info', 'r info'], ['warn', 'r warn'], ['error', 'r error']]);
  });

  it.each([['trace'], ['verbose'], ['WARN'], [undefined]])('nativeLog refuses level %p', level => {
    expect(() => nativeLog(level as never, 'm')).toThrow("nativeLog: level must be 'debug', 'info', 'warn' or 'error'");
    expect(native.nativeLog).not.toHaveBeenCalled();
  });

  it.each([['debug'], ['fault'], [3]])('rctLog refuses level %p', level => {
    expect(() => rctLog(level as never, 'm')).toThrow("rctLog: level must be 'trace', 'info', 'warn' or 'error'");
    expect(native.rctLog).not.toHaveBeenCalled();
  });

  it.each([[''], ['x'.repeat(LOG_MESSAGE_MAX + 1)], [5]])('both refuse the message %p, without echoing it', message => {
    expect(() => nativeLog('info', message as never)).toThrow(`nativeLog: message must be a string of 1 to ${LOG_MESSAGE_MAX} characters`);
    expect(() => rctLog('info', message as never)).toThrow(`rctLog: message must be a string of 1 to ${LOG_MESSAGE_MAX} characters`);
    nativeLog('info', 'x'.repeat(LOG_MESSAGE_MAX));
    expect(native.nativeLog).toHaveBeenCalledTimes(1);
  });

  it('setFlagSecure takes a boolean only', async () => {
    await expect(setFlagSecure(true)).resolves.toBe(true);
    await setFlagSecure(false);
    expect(native.setFlagSecure.mock.calls).toEqual([[true], [false]]);
    expect(() => setFlagSecure(1 as never)).toThrow('setFlagSecure: on must be a boolean');
  });
});
