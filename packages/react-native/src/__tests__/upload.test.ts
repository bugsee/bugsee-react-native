// The package entry now exports the options model, which reads Platform.OS,
// so importing it loads `react-native` -- which jest cannot parse. Mocked to a
// known platform; this suite is about `upload`, not about which one.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import Bugsee from '../index';
import { native } from '../__mocks__/native';

jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

beforeEach(() => native.reset());

describe('upload', () => {
  it('forwards summary and description', () => {
    Bugsee.upload('the summary', 'the description');
    expect(native.upload).toHaveBeenCalledWith('the summary', 'the description');
  });

  // The signature says string, but the call arrives from untyped JS just as
  // often as from TypeScript. A non-string in either position must be
  // rejected here, as a TypeError, rather than reaching the bridge.
  it.each([undefined, null, 42, {}, []])(
    'rejects a non-string summary %p before crossing',
    (summary) => {
      expect(() =>
        Bugsee.upload(summary as unknown as string, 'description'),
      ).toThrow(TypeError);
      expect(native.upload).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, 42, {}, []])(
    'rejects a non-string description %p before crossing',
    (description) => {
      expect(() =>
        Bugsee.upload('summary', description as unknown as string),
      ).toThrow(TypeError);
      expect(native.upload).not.toHaveBeenCalled();
    },
  );

  // The two-argument form only -- severity and labels are Phase 8.
  it('is called with exactly two arguments', () => {
    expect(Bugsee.upload.length).toBe(2);
  });
});
