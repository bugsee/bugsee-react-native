'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  UPLOAD_ARGV,
  main,
  resolveUploadSettings,
  uploadArgv,
  uploadComposedSourceMap,
  uploadDisabled,
} = require('../hermes-sourcemaps');
const { readLog, startStub, stopStub } = require('./fixtures/stub');

// Synthetic, UUID-shaped, never a real app.
const TOKEN = '3f2a9c1e-0000-4abc-8def-5ca1ab1e0001';
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const DEBUG_ID = '54410e32-2841-50e9-a70f-714cec4148b5';
function captureOutput() {
  const lines = [];
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return {
    text: () => lines.join(''),
    restore: () => {
      stderr.mockRestore();
      stdout.mockRestore();
    },
  };
}

describe('source map upload', () => {
  let dir;
  let mapPath;
  let output;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-upload-'));
    mapPath = path.join(dir, 'index.android.bundle.map');
    fs.writeFileSync(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: ['App.tsx'],
        names: [],
        mappings: 'AAAA',
        debug_id: DEBUG_ID,
        debugId: DEBUG_ID,
      }),
    );
    output = captureOutput();
  });

  afterEach(() => {
    output.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('against a local stub', () => {
    let stub;
    let logPath;

    beforeEach(async () => {
      logPath = path.join(dir, 'stub.jsonl');
      stub = await startStub(logPath);
    });

    afterEach(async () => {
      await stopStub(stub);
    });

    it('uploads the composed map keyed by its debug id, with the token only in the request', () => {
      const result = uploadComposedSourceMap({
        composedMapPath: mapPath,
        token: TOKEN,
        endpoint: `http://127.0.0.1:${stub.port}`,
        appVersion: '1.2.3',
        appBuild: '45',
      });

      expect(result).toEqual({ status: 'uploaded', debugId: DEBUG_ID });
      const log = readLog(logPath);
      expect(log.map((entry) => entry.method)).toEqual(['POST', 'PUT']);
      expect(log[0].path).toBe('/apps/<token>/symbols');
      expect(log[0].token).toBe(TOKEN);
      expect(log[0].json).toMatchObject({
        uuid: DEBUG_ID,
        version: '1.2.3',
        build: '45',
        format: 'sourcemap',
      });
      expect(log[1].entries).toEqual([
        expect.objectContaining({ name: 'index.android.bundle.map', debugId: DEBUG_ID }),
      ]);
      const text = output.text();
      expect(text).toContain(`bugsee: uploaded source map ${DEBUG_ID}`);
      expect(text).not.toContain(TOKEN);
    });

    it('does not touch the network for the placeholder token', () => {
      const result = uploadComposedSourceMap({
        composedMapPath: mapPath,
        token: PLACEHOLDER,
        endpoint: `http://127.0.0.1:${stub.port}`,
        appVersion: '1',
        appBuild: '1',
      });
      expect(result).toEqual({ status: 'skipped', reason: 'placeholder' });
      expect(readLog(logPath)).toEqual([]);
      expect(output.text()).toBe(
        'bugsee: source map upload skipped: the app token is the placeholder\n',
      );
    });

    it('does not touch the network when the upload is off', () => {
      const result = uploadComposedSourceMap({
        composedMapPath: mapPath,
        enabled: false,
        token: TOKEN,
        endpoint: `http://127.0.0.1:${stub.port}`,
        appVersion: '1',
        appBuild: '1',
      });
      expect(result).toEqual({ status: 'skipped', reason: 'disabled' });
      expect(readLog(logPath)).toEqual([]);
      expect(output.text()).toBe('bugsee: source map upload skipped: uploadSourcemaps is off\n');
    });

    it('runs main upload end to end from the properties file', () => {
      const properties = path.join(dir, 'bugsee.properties');
      fs.writeFileSync(
        properties,
        `# generated\napp_token=${TOKEN}\nplugin.endpoint=http://127.0.0.1:${stub.port}\n`,
      );
      main([
        'upload',
        '--composed',
        mapPath,
        '--platform',
        'android',
        '--properties',
        properties,
        '--app-version',
        '2.0',
        '--app-build',
        '7',
      ]);
      const log = readLog(logPath);
      expect(log[0].token).toBe(TOKEN);
      expect(log[0].json).toMatchObject({ uuid: DEBUG_ID, version: '2.0', build: '7' });
      expect(output.text()).not.toContain(TOKEN);
    });
  });

  it('warns and returns when the server refuses, without throwing', async () => {
    const logPath = path.join(dir, 'stub.jsonl');
    const stub = await startStub(logPath, ['--fail', '400']);
    try {
      const result = uploadComposedSourceMap({
        composedMapPath: mapPath,
        token: TOKEN,
        endpoint: `http://127.0.0.1:${stub.port}`,
        appVersion: '1',
        appBuild: '1',
      });
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBeGreaterThan(0);
      expect(readLog(logPath)).toHaveLength(1);
      const text = output.text();
      expect(text).toContain(
        `bugsee: source map upload failed (bugsee-cli exit ${result.exitCode}); the app build continues\n`,
      );
      expect(text).not.toContain(TOKEN);
    } finally {
      await stopStub(stub);
    }
  });

  it('skips with one line when no token is configured', () => {
    const spawn = jest.spyOn(cp, 'spawnSync');
    try {
      expect(
        uploadComposedSourceMap({ composedMapPath: mapPath, token: '', appVersion: '1', appBuild: '1' }),
      ).toEqual({ status: 'skipped', reason: 'no-token' });
      expect(uploadComposedSourceMap({ composedMapPath: mapPath, appVersion: '1', appBuild: '1' })).toEqual({
        status: 'skipped',
        reason: 'no-token',
      });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
    expect(output.text()).toBe(
      'bugsee: source map upload skipped: no app token is configured\n'.repeat(2),
    );
  });

  it('skips when the app version or build number is unknown', () => {
    for (const [appVersion, appBuild] of [
      ['', '1'],
      ['1', ''],
      [undefined, '1'],
      ['1', undefined],
    ]) {
      expect(
        uploadComposedSourceMap({ composedMapPath: mapPath, token: TOKEN, appVersion, appBuild }),
      ).toEqual({ status: 'skipped', reason: 'no-version' });
    }
    expect(output.text()).toBe(
      'bugsee: source map upload skipped: the app version or build number is unknown\n'.repeat(4),
    );
  });

  it('skips when the composed map is missing', () => {
    const missing = path.join(dir, 'missing.map');
    expect(
      uploadComposedSourceMap({ composedMapPath: missing, token: TOKEN, appVersion: '1', appBuild: '1' }),
    ).toEqual({ status: 'skipped', reason: 'no-map' });
    expect(output.text()).toBe(`bugsee: source map upload skipped: no source map at ${missing}\n`);
  });

  it('checks the switch before the token, the token before the version, and the version before the map', () => {
    const missing = path.join(dir, 'missing.map');
    expect(uploadComposedSourceMap({ composedMapPath: missing, enabled: false }).reason).toBe('disabled');
    expect(uploadComposedSourceMap({ composedMapPath: missing }).reason).toBe('no-token');
    expect(uploadComposedSourceMap({ composedMapPath: missing, token: TOKEN }).reason).toBe('no-version');
  });

  it('warns when bugsee-cli cannot start, without the error text', () => {
    const result = uploadComposedSourceMap({
      composedMapPath: mapPath,
      token: TOKEN,
      appVersion: '1',
      appBuild: '1',
      cliPath: path.join(dir, 'no-such-cli.js'),
      nodePath: path.join(dir, 'no-such-node'),
    });
    expect(result).toEqual({ status: 'failed', exitCode: null });
    expect(output.text()).toBe(
      'bugsee: source map upload failed (bugsee-cli did not start: ENOENT); the app build continues\n',
    );
  });

  it('passes the token and endpoint through the environment, never argv', () => {
    const spawn = jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 0, stdout: 'out', stderr: 'err' });
    try {
      const result = uploadComposedSourceMap({
        composedMapPath: mapPath,
        token: TOKEN,
        endpoint: 'http://127.0.0.1:1',
        appVersion: '3',
        appBuild: '4',
        cliPath: '/cli.js',
        nodePath: '/node',
      });
      expect(result).toEqual({ status: 'uploaded', debugId: DEBUG_ID });
      expect(spawn).toHaveBeenCalledTimes(1);
      const [file, args, options] = spawn.mock.calls[0];
      expect(file).toBe('/node');
      expect(args).toEqual(['/cli.js', ...uploadArgv(mapPath, '3', '4')]);
      expect(args.join(' ')).not.toContain(TOKEN);
      expect(options.env.BUGSEE_APP_TOKEN).toBe(TOKEN);
      expect(options.env.BUGSEE_ENDPOINT).toBe('http://127.0.0.1:1');
      expect(options.encoding).toBe('utf8');
      expect(options.timeout).toBe(5 * 60 * 1000);
      expect(output.text()).toBe(`outerrbugsee: uploaded source map ${DEBUG_ID}\n`);

      spawn.mockClear();
      const inherited = { ...process.env, BUGSEE_ENDPOINT: 'http://127.0.0.1:2' };
      const saved = process.env;
      process.env = inherited;
      try {
        uploadComposedSourceMap({
          composedMapPath: mapPath,
          token: TOKEN,
          appVersion: '3',
          appBuild: '4',
          cliPath: '/cli.js',
          nodePath: '/node',
        });
      } finally {
        process.env = saved;
      }
      expect(spawn.mock.calls[0][2].env.BUGSEE_ENDPOINT).toBe('http://127.0.0.1:2');
    } finally {
      spawn.mockRestore();
    }
  });

  it('reports a timeout or a signal as a failure', () => {
    const spawn = jest
      .spyOn(cp, 'spawnSync')
      .mockReturnValue({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' });
    try {
      expect(
        uploadComposedSourceMap({
          composedMapPath: mapPath,
          token: TOKEN,
          appVersion: '1',
          appBuild: '1',
          cliPath: '/cli.js',
        }),
      ).toEqual({ status: 'failed', exitCode: null });
    } finally {
      spawn.mockRestore();
    }
    expect(output.text()).toBe(
      'bugsee: source map upload failed (bugsee-cli exit SIGTERM); the app build continues\n',
    );
  });

  it('reports success with a null id for an unreadable map', () => {
    fs.writeFileSync(mapPath, '{');
    const spawn = jest.spyOn(cp, 'spawnSync').mockReturnValue({ status: 0, stdout: '', stderr: '' });
    try {
      expect(
        uploadComposedSourceMap({ composedMapPath: mapPath, token: TOKEN, appVersion: '1', appBuild: '1', cliPath: '/c' }),
      ).toEqual({ status: 'uploaded', debugId: null });
    } finally {
      spawn.mockRestore();
    }
  });

  it('warns when @bugsee/cli is not installed', () => {
    const realRead = fs.readFileSync;
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
      if (String(file).endsWith(path.join('@bugsee', 'cli', 'package.json'))) {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      }
      return realRead(file, ...rest);
    });
    const spawn = jest.spyOn(cp, 'spawnSync');
    try {
      expect(
        uploadComposedSourceMap({ composedMapPath: mapPath, token: TOKEN, appVersion: '1', appBuild: '1' }),
      ).toEqual({ status: 'failed', exitCode: null });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      spawn.mockRestore();
    }
    expect(output.text()).toBe(
      'bugsee: source map upload failed (@bugsee/cli is not installed); the app build continues\n',
    );
  });

  it('builds the CLI argv from the base command, version, build and map', () => {
    expect(UPLOAD_ARGV).toEqual(['debug-files', 'upload', '--type', 'sourcemaps']);
    expect(uploadArgv('/m.map', '1.0', '9')).toEqual([
      'debug-files',
      'upload',
      '--type',
      'sourcemaps',
      '--version',
      '1.0',
      '--build',
      '9',
      '/m.map',
    ]);
  });
});

describe('upload switch', () => {
  it('is on unless the option or BUGSEE_UPLOAD_SOURCEMAPS says false', () => {
    expect(uploadDisabled(undefined, {})).toBe(false);
    expect(uploadDisabled('true', {})).toBe(false);
    expect(uploadDisabled(true, {})).toBe(false);
    expect(uploadDisabled('false', {})).toBe(true);
    expect(uploadDisabled(false, {})).toBe(true);
    expect(uploadDisabled('0', {})).toBe(true);
    expect(uploadDisabled('FALSE', {})).toBe(true);
    expect(uploadDisabled('no', {})).toBe(true);
    expect(uploadDisabled(' Off ', {})).toBe(true);
    expect(uploadDisabled(null, {})).toBe(false);
    expect(uploadDisabled(undefined, { BUGSEE_UPLOAD_SOURCEMAPS: 'false' })).toBe(true);
    expect(uploadDisabled(undefined, { BUGSEE_UPLOAD_SOURCEMAPS: '0' })).toBe(true);
    expect(uploadDisabled(undefined, { BUGSEE_UPLOAD_SOURCEMAPS: 'true' })).toBe(false);
    expect(uploadDisabled(undefined, { BUGSEE_UPLOAD_SOURCEMAPS: '' })).toBe(false);
    expect(uploadDisabled('true', { BUGSEE_UPLOAD_SOURCEMAPS: 'no' })).toBe(true);
  });
});

describe('upload settings', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-settings-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name, text) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  }

  it('prefers the baked token, then properties, then env, then the platform env, then credentials', () => {
    const properties = write('bugsee.properties', 'app_token=props-token\nplugin.endpoint=http://props\n');
    const credentials = write(
      'credentials.json',
      JSON.stringify({ ios: 'creds-ios', android: 'creds-android', endpoint: 'http://creds' }),
    );
    const env = {
      BUGSEE_PLUGIN_APP_TOKEN: 'baked-token',
      BUGSEE_APP_TOKEN: 'env-token',
      BUGSEE_TOKEN_IOS: 'env-ios',
      BUGSEE_TOKEN_ANDROID: 'env-android',
      BUGSEE_ENDPOINT: 'http://env',
    };
    const all = { platform: 'ios', propertiesPath: properties, credentialsPath: credentials, env };
    expect(resolveUploadSettings(all)).toEqual({ token: 'baked-token', endpoint: 'http://props' });

    delete env.BUGSEE_PLUGIN_APP_TOKEN;
    expect(resolveUploadSettings(all).token).toBe('props-token');

    const noProps = { ...all, propertiesPath: path.join(dir, 'absent.properties') };
    expect(resolveUploadSettings(noProps)).toEqual({ token: 'env-token', endpoint: 'http://env' });

    delete env.BUGSEE_APP_TOKEN;
    expect(resolveUploadSettings(noProps).token).toBe('env-ios');
    expect(resolveUploadSettings({ ...noProps, platform: 'android' }).token).toBe('env-android');

    delete env.BUGSEE_TOKEN_IOS;
    delete env.BUGSEE_TOKEN_ANDROID;
    delete env.BUGSEE_ENDPOINT;
    expect(resolveUploadSettings(noProps)).toEqual({ token: 'creds-ios', endpoint: 'http://creds' });
    expect(resolveUploadSettings({ ...noProps, platform: 'android' }).token).toBe('creds-android');

    expect(resolveUploadSettings({ platform: 'ios', env: {} })).toEqual({ token: '', endpoint: '' });
  });

  it('ignores comments, blank values and non-string credentials', () => {
    const properties = write(
      'bugsee.properties',
      '# app_token=commented\n  app_token =  spaced-token  \r\napp_token_\nplugin.endpoint=\nother=x=y\n',
    );
    expect(resolveUploadSettings({ platform: 'android', propertiesPath: properties, env: {} })).toEqual({
      token: 'spaced-token',
      endpoint: '',
    });

    // EAS keeps its own credentials.json with objects under ios/android.
    const eas = write('eas.json', JSON.stringify({ ios: { provisioningProfilePath: 'x' }, endpoint: 7 }));
    expect(resolveUploadSettings({ platform: 'ios', credentialsPath: eas, env: {} })).toEqual({
      token: '',
      endpoint: '',
    });
    const broken = write('broken.json', '{');
    expect(resolveUploadSettings({ platform: 'ios', credentialsPath: broken, env: {} })).toEqual({
      token: '',
      endpoint: '',
    });
    const empty = write('empty.properties', 'app_token=\n');
    expect(
      resolveUploadSettings({ platform: 'android', propertiesPath: empty, env: { BUGSEE_APP_TOKEN: 'env' } })
        .token,
    ).toBe('env');
  });
});
