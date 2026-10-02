// The package entry now exports the options model, which reads Platform.OS,
// so importing it loads `react-native` -- which jest cannot parse. Mocked to a
// known platform; this suite is about `notify`, not about which one.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

import Bugsee, { IssueSeverity } from '../index';
import { notify as notifyDirect } from '../apm/notify';
import { jsonOf, native } from '../__mocks__/native';

beforeEach(() => native.reset());

describe('notify', () => {
  it('the full form crosses title, body, severity by value, fields and urgent', () => {
    const fields = { nonce: 'abc', lane: 'relay' };
    Bugsee.notify('title', 'body', IssueSeverity.Critical, fields, true);
    expect(native.notify).toHaveBeenCalledWith(
      'title',
      'body',
      4,
      jsonOf({ nonce: 'abc', lane: 'relay' }),
      true,
    );
    fields.nonce = 'changed';
    const crossed = native.notify.mock.calls[0]?.[3];
    expect(JSON.parse(crossed as string)).toEqual({ nonce: 'abc', lane: 'relay' });
  });

  it('title alone crosses null body, severity 0, null fields and urgent false', () => {
    Bugsee.notify('title');
    expect(native.notify).toHaveBeenCalledWith('title', null, 0, null, false);
  });

  it('null body, null fields, an empty body and urgent false cross as such', () => {
    Bugsee.notify('title', null, undefined, null, false);
    expect(native.notify).toHaveBeenCalledWith('title', null, 0, null, false);
    native.notify.mockClear();
    Bugsee.notify('title', '', undefined, {});
    expect(native.notify).toHaveBeenCalledWith('title', '', 0, jsonOf({}), false);
  });

  it('rejects an empty or non-string title before crossing', () => {
    const message = 'Bugsee.notify requires a non-empty title';
    expect(() => Bugsee.notify('')).toThrow(message);
    expect(() => Bugsee.notify('   ')).toThrow(message);
    expect(() => Bugsee.notify(1 as unknown as string)).toThrow(message);
    expect(native.notify).not.toHaveBeenCalled();
  });

  it('rejects severity 0, 6 and a string before crossing', () => {
    const message = 'Bugsee.notify severity must be an integer 1..5';
    expect(() => Bugsee.notify('t', 'b', 0 as unknown as IssueSeverity)).toThrow(RangeError);
    expect(() => Bugsee.notify('t', 'b', 0 as unknown as IssueSeverity)).toThrow(message);
    expect(() => Bugsee.notify('t', 'b', 6 as unknown as IssueSeverity)).toThrow(RangeError);
    expect(() => Bugsee.notify('t', 'b', 'high' as unknown as IssueSeverity)).toThrow(TypeError);
    expect(() => Bugsee.notify('t', 'b', 'high' as unknown as IssueSeverity)).toThrow(message);
    expect(native.notify).not.toHaveBeenCalled();
  });

  it('rejects a field that is not a string before crossing', () => {
    const message = 'Bugsee.notify fields must be an object of strings';
    expect(() =>
      Bugsee.notify('t', 'b', undefined, { n: 1 } as unknown as Record<string, string>),
    ).toThrow(message);
    expect(() => Bugsee.notify('t', null, undefined, [] as unknown as Record<string, string>)).toThrow(
      message,
    );
    expect(() => Bugsee.notify('t', null, undefined, 'x' as unknown as Record<string, string>)).toThrow(
      message,
    );
    expect(native.notify).not.toHaveBeenCalled();
  });

  it('rejects a non-string body before crossing', () => {
    expect(() => Bugsee.notify('t', 1 as unknown as string)).toThrow('Bugsee.notify body must be a string');
    expect(native.notify).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean urgent before crossing', () => {
    expect(() =>
      Bugsee.notify('t', 'b', undefined, undefined, 'yes' as unknown as boolean),
    ).toThrow('Bugsee.notify urgent must be a boolean');
    expect(native.notify).not.toHaveBeenCalled();
  });

  it('a sixth argument throws TypeError and crosses nothing', () => {
    const message = 'Bugsee.notify takes at most five arguments';
    expect(() =>
      (Bugsee.notify as (...args: unknown[]) => void)(
        't',
        'b',
        IssueSeverity.High,
        null,
        false,
        'extra',
      ),
    ).toThrow(message);
    expect(() =>
      (notifyDirect as (...args: unknown[]) => void)('t', 'b', undefined, null, false, 'extra'),
    ).toThrow(message);
    expect(native.notify).not.toHaveBeenCalled();
  });
});
