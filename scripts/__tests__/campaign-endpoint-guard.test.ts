import {
  DEAD_ENDPOINT,
  STAGING_ENDPOINT,
  checkCredentials,
  checkLaunch,
  isPlaceholderToken,
  launchFactsOf,
  namesProduction,
  parseCampaignMode,
} from '../campaign-endpoint-guard';

/**
 * Campaign N-30: nothing reaches a device but the dead endpoint (offline) or
 * exactly the staging endpoint (E2E_STAGING=1); production never.
 */
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const REAL = '1f2e3d4c-5b6a-4789-8abc-def012345678';

describe('parseCampaignMode', () => {
  it.each([[undefined], [''], ['0']])('%p is offline', raw => {
    expect(parseCampaignMode(raw)).toBe('offline');
  });

  it('1 is staging', () => {
    expect(parseCampaignMode('1')).toBe('staging');
  });

  it.each([['true'], ['yes'], ['2'], [' 1']])('%p throws, naming the variable', raw => {
    expect(() => parseCampaignMode(raw)).toThrow(/^E2E_STAGING must be "1" or "0", got /);
  });
});

describe('namesProduction', () => {
  it.each([
    ['api.bugsee.com'],
    ['https://api.bugsee.com'],
    ['https://api.bugsee.com/v2'],
    ['HTTPS://API.BUGSEE.COM'],
    ['https://api.bugsee.com.'],
    ['https://api.bugsee.com:443/x'],
    ['http://api.bugsee.com'],
    ['endpoint=https%3A%2F%2Fapi.bugsee.com'],
    ['{"endpoint":"https://api.bugsee.com"}'],
    ['x api.bugsee.com'],
  ])('finds %p', text => {
    expect(namesProduction(text)).toBe(true);
  });

  it.each([
    ['https://apidev.bugsee.com'],
    ['https://xapi.bugsee.com'],
    ['https://my-api.bugsee.com'],
    ['https://127.0.0.1:9'],
    ['https://api.bugsee.company'],
    ['https://api.bugsee.com-other.example'],
    [''],
    ['%E0%A4%A'],
  ])('does not find %p', text => {
    expect(namesProduction(text)).toBe(false);
  });
});

describe('checkLaunch', () => {
  it('offline: the placeholder against the dead endpoint is allowed', () => {
    expect(checkLaunch('offline', { token: 'placeholder', endpoint: DEAD_ENDPOINT })).toEqual({ ok: true, reason: 'ok' });
  });

  it('offline: a real token is refused even against the dead endpoint', () => {
    expect(checkLaunch('offline', { token: 'set', endpoint: DEAD_ENDPOINT })).toEqual({
      ok: false,
      reason: 'a real token outside the staging lane (E2E_STAGING is not 1)',
    });
  });

  it('offline: another endpoint is refused', () => {
    expect(checkLaunch('offline', { token: 'placeholder', endpoint: STAGING_ENDPOINT })).toEqual({
      ok: false,
      reason: `offline mode launches only against ${DEAD_ENDPOINT}`,
    });
  });

  it.each([['default'], [''], ['  ']])('the SDK default endpoint %p is refused in both modes', endpoint => {
    for (const mode of ['offline', 'staging'] as const) {
      expect(checkLaunch(mode, { token: 'set', endpoint })).toEqual({
        ok: false,
        reason: "the SDK's default endpoint (production) was left in place",
      });
    }
  });

  it('production is refused in both modes, before anything else', () => {
    for (const mode of ['offline', 'staging'] as const) {
      for (const token of ['set', 'placeholder'] as const) {
        expect(checkLaunch(mode, { token, endpoint: 'https://api.bugsee.com' })).toEqual({
          ok: false,
          reason: 'the endpoint names the production API',
        });
      }
    }
  });

  it('staging: a real token against exactly the staging endpoint is allowed (surrounding space ignored)', () => {
    expect(checkLaunch('staging', { token: 'set', endpoint: STAGING_ENDPOINT })).toEqual({ ok: true, reason: 'ok' });
    expect(checkLaunch('staging', { token: 'set', endpoint: ` ${STAGING_ENDPOINT} ` }).ok).toBe(true);
  });

  it.each([['https://apidev.bugsee.com/'], ['https://apidev.bugsee.com/v2'], ['http://apidev.bugsee.com'], [DEAD_ENDPOINT]])(
    'staging: %p is not exactly the staging endpoint',
    endpoint => {
      expect(checkLaunch('staging', { token: 'set', endpoint })).toEqual({
        ok: false,
        reason: `staging mode launches only against exactly ${STAGING_ENDPOINT}`,
      });
    },
  );

  it('staging: the placeholder token is refused', () => {
    expect(checkLaunch('staging', { token: 'placeholder', endpoint: STAGING_ENDPOINT })).toEqual({
      ok: false,
      reason: 'staging mode with the placeholder token: nothing would reach staging',
    });
  });
});

describe('launchFactsOf', () => {
  it("reads the app's launch line", () => {
    expect(
      launchFactsOf(
        'BUGSEE_E2E scenario=launch nonce=ab12 source=uri dev=true token=placeholder endpoint=https://127.0.0.1:9',
      ),
    ).toEqual({ token: 'placeholder', endpoint: 'https://127.0.0.1:9' });
    expect(launchFactsOf('... dev=false token=set endpoint=default')).toEqual({ token: 'set', endpoint: 'default' });
  });

  it.each([['BUGSEE_E2E scenario=launch nonce=ab12'], ['token=other endpoint=x'], ['token=set']])('%p has no facts', line => {
    expect(launchFactsOf(line)).toBeUndefined();
  });
});

describe('isPlaceholderToken', () => {
  it.each([[PLACEHOLDER], ['00000000000040008000000000000000'], ['00000000-0000-1000-a000-000000000000']])('%p is', token => {
    expect(isPlaceholderToken(token)).toBe(true);
  });
  it.each([[REAL], [''], ['0000'], ['00000000-0000-4000-8000-000000000001']])('%p is not', token => {
    expect(isPlaceholderToken(token)).toBe(false);
  });
});

describe('checkCredentials', () => {
  const offlineProps = `# generated\napp_token=${PLACEHOLDER}\nplugin.endpoint=${DEAD_ENDPOINT}\n`;

  it('offline: placeholder tokens and the dead endpoint pass', () => {
    expect(
      checkCredentials('offline', { json: { ios: PLACEHOLDER, android: PLACEHOLDER, endpoint: DEAD_ENDPOINT }, properties: offlineProps }),
    ).toEqual({ ok: true, reason: 'ok' });
  });

  it('offline: no endpoint at all passes (the app forces the dead one for a placeholder)', () => {
    expect(checkCredentials('offline', { json: { ios: PLACEHOLDER, android: '', endpoint: '' } }).ok).toBe(true);
    expect(checkCredentials('offline', {}).ok).toBe(true);
  });

  it('offline: a real token anywhere is refused, naming where', () => {
    expect(checkCredentials('offline', { json: { ios: REAL, android: PLACEHOLDER, endpoint: '' } })).toEqual({
      ok: false,
      reason: 'a real token outside the staging lane: credentials.json ios',
    });
    expect(checkCredentials('offline', { json: { android: REAL } }).reason).toBe(
      'a real token outside the staging lane: credentials.json android',
    );
    expect(checkCredentials('offline', { properties: `app_token=${REAL}\n` }).reason).toBe(
      'a real token outside the staging lane: bugsee.properties app_token',
    );
    expect(checkCredentials('offline', { properties: `plugin.appToken: ${REAL}\n` }).reason).toBe(
      'a real token outside the staging lane: bugsee.properties plugin.appToken',
    );
  });

  it('a commented-out line is not read', () => {
    expect(checkCredentials('offline', { properties: `# app_token=${REAL}\n# plugin.endpoint=https://x.example\n` }).ok).toBe(true);
  });

  it('offline: an endpoint other than the dead one is refused', () => {
    expect(checkCredentials('offline', { json: { endpoint: STAGING_ENDPOINT } })).toEqual({
      ok: false,
      reason: `credentials.json endpoint is not ${DEAD_ENDPOINT}`,
    });
    expect(checkCredentials('offline', { properties: 'plugin.endpoint=https://x.example\n' })).toEqual({
      ok: false,
      reason: `bugsee.properties plugin.endpoint is not ${DEAD_ENDPOINT}`,
    });
  });

  it('production anywhere in either file is refused', () => {
    expect(checkCredentials('staging', { json: { ios: REAL, endpoint: 'https://api.bugsee.com' } }).reason).toBe(
      'a credential file names the production API',
    );
    expect(checkCredentials('offline', { properties: '# note: api.bugsee.com\n' }).reason).toBe(
      'a credential file names the production API',
    );
  });

  it('a non-string token or endpoint is refused', () => {
    expect(checkCredentials('offline', { json: { ios: 5 } })).toEqual({ ok: false, reason: 'credentials.json ios is not a string' });
    expect(checkCredentials('offline', { json: { endpoint: null } })).toEqual({
      ok: false,
      reason: 'credentials.json endpoint is not a string',
    });
  });

  it('staging: a real token and exactly the staging endpoint in both files pass', () => {
    expect(
      checkCredentials('staging', {
        json: { ios: REAL, android: REAL, endpoint: STAGING_ENDPOINT },
        properties: `app_token=${REAL}\nplugin.endpoint=${STAGING_ENDPOINT}\n`,
      }),
    ).toEqual({ ok: true, reason: 'ok' });
  });

  it('staging: the placeholder only is refused', () => {
    expect(checkCredentials('staging', { json: { ios: PLACEHOLDER, endpoint: STAGING_ENDPOINT } })).toEqual({
      ok: false,
      reason: 'staging mode with no real token',
    });
  });

  it('staging: no credentials.json endpoint is refused (the SDK default is production)', () => {
    for (const endpoint of [undefined, '', '  ']) {
      expect(checkCredentials('staging', { json: { ios: REAL, endpoint } }).reason).toBe(
        `staging mode with no credentials.json endpoint: the SDK default is production; set ${STAGING_ENDPOINT}`,
      );
    }
  });

  it('staging: another endpoint is refused', () => {
    expect(checkCredentials('staging', { json: { ios: REAL, endpoint: DEAD_ENDPOINT } }).reason).toBe(
      `credentials.json endpoint is not ${STAGING_ENDPOINT}`,
    );
  });

  it('staging: a real Gradle-plugin token with no plugin endpoint is refused', () => {
    expect(
      checkCredentials('staging', { json: { ios: REAL, endpoint: STAGING_ENDPOINT }, properties: `app_token=${REAL}\n` }).reason,
    ).toBe('bugsee.properties has a real app_token but no plugin.endpoint: the Gradle plugin would upload to production');
    expect(
      checkCredentials('staging', {
        json: { ios: REAL, endpoint: STAGING_ENDPOINT },
        properties: `app_token=${PLACEHOLDER}\n`,
      }).ok,
    ).toBe(true);
  });
});
