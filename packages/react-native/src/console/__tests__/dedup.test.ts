jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import {
  ECHO_WINDOW_MS,
  classifyFilterRequest,
  claimEcho,
  isConsoleStampOf,
  protectLine,
  readDev,
  resetConsoleDedup,
  shouldDropConsoleEcho,
  shouldForwardJsPatch,
} from '../dedup';

beforeEach(() => {
  resetConsoleDedup();
});

describe('console stream dedup', () => {
  it('reads an absent __DEV__ as a release build', () => {
    expect(readDev()).toBe(false);
  });

  it('reads a boolean __DEV__ and ignores any other value', () => {
    const host = globalThis as { __DEV__?: unknown };
    host.__DEV__ = true;
    expect(readDev()).toBe(true);
    host.__DEV__ = false;
    expect(readDev()).toBe(false);
    host.__DEV__ = 'yes';
    expect(readDev()).toBe(false);
    delete host.__DEV__;
  });

  it('keeps the JS patch in a dev build, where RCTLog also sees the call', () => {
    expect(shouldForwardJsPatch(true)).toBe(true);
  });

  it('keeps the JS patch in a release build, where RCTLog does not see console', () => {
    expect(shouldForwardJsPatch(false)).toBe(true);
  });

  it('drops the dev echo of a call the JS patch owns', () => {
    expect(shouldDropConsoleEcho(true, true)).toBe(true);
  });

  it('drops a release echo of a call the JS patch owns, and does not drop the patch', () => {
    expect(shouldDropConsoleEcho(false, true)).toBe(true);
    expect(shouldForwardJsPatch(false)).toBe(true);
  });

  it('keeps an RCTLog line the JS patch does not own, in dev and in release', () => {
    expect(shouldDropConsoleEcho(true, false)).toBe(false);
    expect(shouldDropConsoleEcho(false, false)).toBe(false);
  });

  it('delivers the patch line and drops a differently formatted echo, even if the echo is asked first', () => {
    protectLine('seen [object Object]');
    claimEcho("seen { a: 's3cret' }");

    expect(classifyFilterRequest("seen { a: 's3cret' }")).toBe('drop');
    expect(classifyFilterRequest('seen [object Object]')).toBe('deliver');
    expect(classifyFilterRequest("seen { a: 's3cret' }")).toBe('deliver');
  });

  it('delivers one copy when the echo text equals the patch line', () => {
    protectLine('BUGSEE_E2E dedup');
    claimEcho('BUGSEE_E2E dedup');

    expect(classifyFilterRequest('BUGSEE_E2E dedup')).toBe('deliver');
    expect(classifyFilterRequest('BUGSEE_E2E dedup')).toBe('drop');
  });

  it('drops the iOS console stamp of a claimed line and still delivers the patch', () => {
    const message = 'BUGSEE_E2E dedup-line e4937302c158';
    const stamped =
      '2026-10-02 18:40:35.273 BareExample[60839:42420530] BUGSEE_E2E dedup-line e4937302c158';
    expect(isConsoleStampOf(stamped, message)).toBe(true);
    expect(isConsoleStampOf(message, message)).toBe(false);
    expect(isConsoleStampOf(`note ${message}`, message)).toBe(false);
    expect(isConsoleStampOf('', message)).toBe(false);
    expect(
      isConsoleStampOf('2026-10-02 18:40:35.273 BareExample[60839:42420530] ', ''),
    ).toBe(false);
    expect(isConsoleStampOf(`[60839:42420530] ${message}`, message)).toBe(false);
    expect(isConsoleStampOf(`x${stamped}`, message)).toBe(false);
    expect(isConsoleStampOf(`${stamped} trailing`, message)).toBe(false);
    expect(
      isConsoleStampOf(`2026-10-02 18:40:35.273 BareExample[nope] ${message}`, message),
    ).toBe(false);
    expect(
      isConsoleStampOf(`2026-10-02 18:40:35.273 BareExample[x60839:42420530] ${message}`, message),
    ).toBe(false);
    expect(
      isConsoleStampOf(`2026-10-02 18:40:35.273 BareExample[60839:42420530x] ${message}`, message),
    ).toBe(false);
    expect(
      isConsoleStampOf(`2026-10-02 18:40:35.273 BareExample extra[60839:42420530] ${message}`, message),
    ).toBe(false);

    protectLine(message);
    claimEcho(message);
    expect(classifyFilterRequest(stamped)).toBe('drop');
    expect(classifyFilterRequest(message)).toBe('deliver');
    expect(classifyFilterRequest(message)).toBe('drop');
    expect(classifyFilterRequest(stamped)).toBe('deliver');
  });

  it('delivers a native line that was never an echo', () => {
    protectLine('from the patch');
    expect(classifyFilterRequest('React Native module failed')).toBe('deliver');
    expect(classifyFilterRequest('from the patch')).toBe('deliver');
  });

  it('keeps only the newest claims once the ledger is full', () => {
    for (let index = 0; index < 33; index += 1) {
      claimEcho(`line-${index}`, 0);
    }
    expect(classifyFilterRequest('line-0', 1)).toBe('deliver');
    expect(classifyFilterRequest('line-1', 1)).toBe('drop');
    expect(classifyFilterRequest('line-32', 1)).toBe('drop');
  });

  it('reset forgets a claim', () => {
    claimEcho('leftover', 0);
    resetConsoleDedup();
    expect(classifyFilterRequest('leftover', 1)).toBe('deliver');
  });

  it('drops an expired protected line so a live echo of that text is the one suppressed', () => {
    protectLine('aged', 0);
    claimEcho('aged', 1_000);
    expect(classifyFilterRequest('aged', ECHO_WINDOW_MS)).toBe('drop');
  });

  it('keeps only the newest protected lines once that ledger is full', () => {
    for (let index = 0; index < 33; index += 1) {
      protectLine(`kept-${index}`, 0);
    }
    claimEcho('kept-0', 1);
    claimEcho('kept-1', 1);
    expect(classifyFilterRequest('kept-0', 1)).toBe('drop');
    expect(classifyFilterRequest('kept-1', 1)).toBe('deliver');
    expect(classifyFilterRequest('kept-32', 1)).toBe('deliver');
  });

  it('forgets an echo claim once the window has elapsed', () => {
    claimEcho('stale', 0);
    expect(classifyFilterRequest('stale', ECHO_WINDOW_MS)).toBe('deliver');
  });

  it('still drops an echo claim inside the window', () => {
    claimEcho('fresh', 0);
    expect(classifyFilterRequest('fresh', ECHO_WINDOW_MS - 1)).toBe('drop');
  });
});
