const getEnforcing = jest.fn(() => ({}));
jest.mock('react-native', () => ({
  TurboModuleRegistry: { getEnforcing },
}));

import { requireNewArchitecture } from '../architecture';

type Globals = Record<string, unknown>;

function importNativeWith(globals: Globals): () => void {
  return () => {
    const g = globalThis as Globals;
    Object.assign(g, globals);
    try {
      jest.isolateModules(() => {
        require('../NativeBugseeFeedback');
      });
    } finally {
      for (const k of Object.keys(globals)) delete g[k];
    }
  };
}

beforeEach(() => getEnforcing.mockClear());

describe('the feedback module on the legacy architecture', () => {
  it('fails at import, naming this package and its module, before the registry is asked', () => {
    expect(importNativeWith({})).toThrow(
      /^@bugsee\/react-native-feedback: the native module 'BugseeFeedbackModule' needs React Native's New Architecture, and this app runs the legacy architecture\./,
    );
    expect(getEnforcing).not.toHaveBeenCalled();
  });
  it('names the fix', () => {
    expect(() => requireNewArchitecture({})).toThrow(/newArchEnabled=true in android\/gradle\.properties; RCT_NEW_ARCH_ENABLED=1/);
  });
});

describe('the feedback module on the New Architecture', () => {
  it.each([
    ['bridgeless', { RN$Bridgeless: true }],
    ['with a bridge (a TurboModule proxy)', { __turboModuleProxy: () => null }],
  ])('looks the module up %s', (_label, globals) => {
    expect(importNativeWith(globals)).not.toThrow();
    expect(getEnforcing).toHaveBeenCalledWith('BugseeFeedbackModule');
  });
  it('rejects look-alike markers', () => {
    expect(() => requireNewArchitecture({ RN$Bridgeless: 'true' })).toThrow();
    expect(() => requireNewArchitecture({ __turboModuleProxy: {} })).toThrow();
  });
});
