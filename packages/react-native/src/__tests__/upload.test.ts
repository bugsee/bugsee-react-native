// The package entry now exports the options model, which reads Platform.OS,
// so importing it loads `react-native` -- which jest cannot parse. Mocked to a
// known platform; this suite is about `upload`, not about which one.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import Bugsee, { IssueSeverity } from '../index';
import { native } from '../__mocks__/native';

jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

beforeEach(() => native.reset());

describe('upload', () => {
  it('the two-argument form crosses severity 0 and null labels', () => {
    Bugsee.upload('the summary', 'the description');
    expect(native.upload).toHaveBeenCalledWith(
      'the summary',
      'the description',
      0,
      null,
    );
  });

  it('severity crosses by value', () => {
    Bugsee.upload('s', 'd', IssueSeverity.Critical);
    expect(native.upload).toHaveBeenCalledWith('s', 'd', 4, null);
    native.reset();
    Bugsee.upload('s', 'd', IssueSeverity.VeryLow);
    expect(native.upload).toHaveBeenCalledWith('s', 'd', 1, null);
  });

  it('labels cross as a copy', () => {
    const labels = ['alpha', 'beta'];
    Bugsee.upload('s', 'd', IssueSeverity.High, labels);
    const crossed = native.upload.mock.calls[0]?.[3];
    expect(crossed).toEqual(['alpha', 'beta']);
    expect(crossed).not.toBe(labels);
    labels.push('gamma');
    expect(crossed).toEqual(['alpha', 'beta']);
  });

  it('rejects severity 0, 6, 2.5 and a string before crossing', () => {
    expect(() =>
      Bugsee.upload('s', 'd', 0 as unknown as IssueSeverity),
    ).toThrow(RangeError);
    expect(() =>
      Bugsee.upload('s', 'd', 6 as unknown as IssueSeverity),
    ).toThrow(RangeError);
    expect(() =>
      Bugsee.upload('s', 'd', 2.5 as unknown as IssueSeverity),
    ).toThrow(RangeError);
    expect(() =>
      Bugsee.upload('s', 'd', 'high' as unknown as IssueSeverity),
    ).toThrow(TypeError);
    expect(native.upload).not.toHaveBeenCalled();
  });

  it('rejects labels that are not strings before crossing', () => {
    expect(() =>
      Bugsee.upload('s', 'd', undefined, 'nope' as unknown as string[]),
    ).toThrow(TypeError);
    expect(() =>
      Bugsee.upload('s', 'd', undefined, [1] as unknown as string[]),
    ).toThrow(TypeError);
    expect(() =>
      Bugsee.upload('s', 'd', undefined, null as unknown as string[]),
    ).toThrow(TypeError);
    expect(native.upload).not.toHaveBeenCalled();
  });

  it('a fifth argument throws TypeError and crosses nothing', () => {
    expect(() =>
      (Bugsee.upload as (...args: unknown[]) => void)(
        'summary',
        'description',
        IssueSeverity.High,
        ['a'],
        true,
      ),
    ).toThrow(
      new TypeError(
        'Bugsee.upload takes at most four arguments; 7.x has no includeVideo',
      ),
    );
    expect(native.upload).not.toHaveBeenCalled();
  });

  it('upload has no fifth parameter', () => {
    Bugsee.upload('summary', 'description', IssueSeverity.High, ['label']);
    expect(() => {
      // @ts-expect-error upload has no fifth parameter
      Bugsee.upload('summary', 'description', IssueSeverity.High, ['label'], true);
    }).toThrow(TypeError);
  });

  it('no message contains the rejected value', () => {
    const severitySecret = 'SECRET_SEVERITY_VALUE';
    expect(() =>
      Bugsee.upload('summary', 'description', severitySecret as never),
    ).toThrow(TypeError);
    try {
      Bugsee.upload('summary', 'description', severitySecret as never);
    } catch (error) {
      expect((error as Error).message).not.toContain(severitySecret);
    }

    const labelSecret = 'SECRET_LABEL_VALUE';
    expect(() =>
      Bugsee.upload('summary', 'description', IssueSeverity.High, [
        labelSecret,
        1,
      ] as never),
    ).toThrow(TypeError);
    try {
      Bugsee.upload('summary', 'description', IssueSeverity.High, [
        labelSecret,
        1,
      ] as never);
    } catch (error) {
      expect((error as Error).message).not.toContain(labelSecret);
    }

    const fifth = 'SECRET_FIFTH_ARGUMENT';
    expect(() =>
      (Bugsee.upload as (...args: unknown[]) => void)(
        'summary',
        'description',
        1,
        ['a'],
        fifth,
      ),
    ).toThrow(TypeError);
    try {
      (Bugsee.upload as (...args: unknown[]) => void)(
        'summary',
        'description',
        1,
        ['a'],
        fifth,
      );
    } catch (error) {
      expect((error as Error).message).not.toContain(fifth);
    }
    expect(native.upload).not.toHaveBeenCalled();
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

});
