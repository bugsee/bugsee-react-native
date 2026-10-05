'use strict';

// Review 13.6, Important 1: no test, mutant or CI step may reach a real
// Bugsee endpoint. scripts/jest-no-network.js (jest setupFiles) makes a dead
// loopback endpoint the default and refuses to spawn bugsee-cli without a
// loopback endpoint; this file proves both hold.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { uploadComposedSourceMap } = require('../hermes-sourcemaps');
const { useScratchCwd } = require('./fixtures/scratch-cwd');

useScratchCwd();

const DEAD = 'http://127.0.0.1:9';
const TOKEN = '3f2a9c1e-0000-4abc-8def-5ca1ab1e0001';
const FAKE_CLI = '/nowhere/node_modules/@bugsee/cli/bin/bugsee-cli.js';

describe('no real Bugsee endpoint', () => {
  it('runs every test with a dead loopback endpoint and a refusing proxy', () => {
    expect(process.env.BUGSEE_ENDPOINT).toBe(DEAD);
    expect(process.env.HTTPS_PROXY || process.env.https_proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(process.env.NO_PROXY).toBe('127.0.0.1,localhost,::1');
  });

  it('refuses to spawn bugsee-cli with a non-loopback or missing endpoint', () => {
    for (const env of [{ BUGSEE_ENDPOINT: 'https://api.bugsee.com' }, {}, { BUGSEE_ENDPOINT: 'http://127.0.0.1.evil:9' }]) {
      expect(() => cp.spawnSync(process.execPath, [FAKE_CLI, '--version'], { env })).toThrow(
        'refusing to spawn bugsee-cli without a loopback BUGSEE_ENDPOINT',
      );
      expect(() => cp.spawn(process.execPath, [FAKE_CLI], { env })).toThrow('without a loopback BUGSEE_ENDPOINT');
    }
    // Inherited from this process, or explicit loopback: allowed (the fake path just fails to load).
    expect(cp.spawnSync(process.execPath, [FAKE_CLI], { encoding: 'utf8' }).status).not.toBe(0);
    for (const endpoint of ['http://127.0.0.1:47731', 'http://localhost:1/', 'http://[::1]:9']) {
      expect(cp.spawnSync(process.execPath, [FAKE_CLI], { env: { BUGSEE_ENDPOINT: endpoint } }).status).not.toBe(0);
    }
    // Anything that is not the CLI is untouched.
    expect(cp.spawnSync(process.execPath, ['-e', ''], { env: {} }).status).toBe(0);
  });

  it('sends a real upload with a token and no endpoint to the dead loopback, never to production', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-dead-endpoint-'));
    const mapPath = path.join(dir, 'm.map');
    const id = '54410e32-2841-50e9-a70f-714cec4148b5';
    fs.writeFileSync(mapPath, JSON.stringify({ version: 3, sources: [], names: [], mappings: '', debug_id: id, debugId: id }));
    const out = [];
    const write = (chunk) => {
      out.push(String(chunk));
      return true;
    };
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(write);
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(write);
    const spawn = jest.spyOn(cp, 'spawnSync');
    const savedLog = process.env.RUST_LOG;
    process.env.RUST_LOG = 'bugsee_cli=debug';
    let result;
    try {
      result = uploadComposedSourceMap({ composedMapPath: mapPath, token: TOKEN, appVersion: '1', appBuild: '1' });
    } finally {
      if (savedLog === undefined) delete process.env.RUST_LOG;
      else process.env.RUST_LOG = savedLog;
      stderr.mockRestore();
      stdout.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const childEnv = spawn.mock.calls[0][2].env;
    spawn.mockRestore();
    expect(childEnv.BUGSEE_ENDPOINT).toBe(DEAD);
    expect(result.status).toBe('failed');
    const text = out.join('');
    expect(text).toContain('127.0.0.1:9');
    expect(text).not.toContain('api.bugsee.com');
    expect(text).not.toContain(TOKEN);
  });
});
