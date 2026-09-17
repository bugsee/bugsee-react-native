const getEnforcing = jest.fn(() => ({}));
jest.mock('react-native', () => ({
  TurboModuleRegistry: { getEnforcing },
}));

describe('the TurboModule name', () => {
  // Load-bearing, and not obviously so. RN falls back to
  // NSClassFromString(@"<name>") when no provider is registered, and on iOS
  // "Bugsee" resolves to the SDK's OWN class, not the module — which is why
  // codegenConfig.ios.modulesProvider maps Bugsee -> BugseeModule. Rename the
  // module here and that mapping silently stops applying.
  it('is exactly "Bugsee", matching codegenConfig.ios.modulesProvider', () => {
    jest.isolateModules(() => {
      require('../NativeBugsee');
    });
    expect(getEnforcing).toHaveBeenCalledWith('Bugsee');
  });
});
