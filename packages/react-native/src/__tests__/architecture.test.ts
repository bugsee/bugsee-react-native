const getEnforcing = jest.fn(() => ({}));
jest.mock('react-native', () => ({
  TurboModuleRegistry: { getEnforcing },
}));

import { LEGACY_ARCHITECTURE_MESSAGE, isNewArchitecture, requireNewArchitecture } from '../architecture';

type Globals = Record<string, unknown>;
const KEYS = ['RN$Bridgeless', '__turboModuleProxy'] as const;

/** Runs `body` with exactly `globals` set for the two architecture keys. */
function withGlobals(globals: Globals, body: () => void): void {
  const g = globalThis as Globals;
  const saved = KEYS.map((k) => [k, Object.prototype.hasOwnProperty.call(g, k), g[k]] as const);
  for (const k of KEYS) delete g[k];
  Object.assign(g, globals);
  try {
    body();
  } finally {
    for (const [k, had, value] of saved) {
      if (had) g[k] = value;
      else delete g[k];
    }
  }
}

function importNative(): unknown {
  let mod: unknown;
  jest.isolateModules(() => {
    mod = require('../NativeBugsee');
  });
  return mod;
}

beforeEach(() => getEnforcing.mockClear());

describe('isNewArchitecture', () => {
  it('is true when bridgeless', () => {
    expect(isNewArchitecture({ RN$Bridgeless: true })).toBe(true);
  });
  it('is true on the New Architecture with a bridge (a TurboModule proxy)', () => {
    expect(isNewArchitecture({ __turboModuleProxy: () => null })).toBe(true);
  });
  it('is false on the legacy architecture (neither global)', () => {
    expect(isNewArchitecture({})).toBe(false);
  });
  it('takes only the exact markers: a truthy non-true flag or a non-function proxy is not one', () => {
    expect(isNewArchitecture({ RN$Bridgeless: 'true' })).toBe(false);
    expect(isNewArchitecture({ RN$Bridgeless: false })).toBe(false);
    expect(isNewArchitecture({ __turboModuleProxy: {} })).toBe(false);
    expect(isNewArchitecture({ __turboModuleProxy: null })).toBe(false);
  });
});

describe('requireNewArchitecture', () => {
  it('throws the documented message on the legacy architecture', () => {
    expect(() => requireNewArchitecture({})).toThrow(new Error(LEGACY_ARCHITECTURE_MESSAGE));
  });
  it('does not throw on the New Architecture', () => {
    expect(() => requireNewArchitecture({ RN$Bridgeless: true })).not.toThrow();
    expect(() => requireNewArchitecture({ __turboModuleProxy: () => null })).not.toThrow();
  });
  it('reads globalThis by default', () => {
    withGlobals({}, () => expect(() => requireNewArchitecture()).toThrow(/legacy architecture/));
    withGlobals({ RN$Bridgeless: true }, () => expect(() => requireNewArchitecture()).not.toThrow());
  });
  it('names the package, the module, the cause and the fix', () => {
    const message = LEGACY_ARCHITECTURE_MESSAGE;
    expect(message).toMatch(/^@bugsee\/react-native: /);
    expect(message).toContain("'Bugsee'");
    expect(message).toContain('New Architecture');
    expect(message).toContain('legacy architecture');
    expect(message).toContain('newArchEnabled=true in android/gradle.properties');
    expect(message).toContain('RCT_NEW_ARCH_ENABLED=1');
  });
});

describe('importing the native module', () => {
  it('fails at import on the legacy architecture, before the registry is asked', () => {
    withGlobals({}, () => {
      expect(importNative).toThrow(new Error(LEGACY_ARCHITECTURE_MESSAGE));
    });
    expect(getEnforcing).not.toHaveBeenCalled();
  });
  it('looks the module up when bridgeless', () => {
    withGlobals({ RN$Bridgeless: true }, () => {
      expect(importNative).not.toThrow();
    });
    expect(getEnforcing).toHaveBeenCalledWith('Bugsee');
  });
  it('looks the module up on the New Architecture with a bridge', () => {
    withGlobals({ __turboModuleProxy: () => null }, () => {
      expect(importNative).not.toThrow();
    });
    expect(getEnforcing).toHaveBeenCalledWith('Bugsee');
  });
});
