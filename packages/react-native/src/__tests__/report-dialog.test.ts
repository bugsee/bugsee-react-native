// The package entry now exports the options model, which reads Platform.OS,
// so importing it loads `react-native` -- which jest cannot parse. Mocked to a
// known platform; this suite is about `showReportDialog`, not about which one.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import Bugsee, { IssueSeverity } from '../index';
import { native } from '../__mocks__/native';

jest.mock('../NativeBugsee', () => require('../__mocks__/native').nativeMock);

beforeEach(() => native.reset());

describe('showReportDialog', () => {
  it('no arguments crosses null, null, 0, null', () => {
    Bugsee.showReportDialog();
    expect(native.showReportDialog).toHaveBeenCalledWith(null, null, 0, null);
  });

  it('every argument crosses in order', () => {
    const labels = ['dlg', 'two'];
    Bugsee.showReportDialog('sum', 'desc', IssueSeverity.Critical, labels);
    expect(native.showReportDialog).toHaveBeenCalledWith('sum', 'desc', 4, [
      'dlg',
      'two',
    ]);
    const crossed = native.showReportDialog.mock.calls[0]?.[3];
    expect(crossed).not.toBe(labels);
  });

  it('a non-string summary or description throws before crossing', () => {
    expect(() => Bugsee.showReportDialog(42 as never)).toThrow(
      new TypeError(
        'Bugsee.showReportDialog requires summary to be a string, got number',
      ),
    );
    expect(() => Bugsee.showReportDialog('ok', 42 as never)).toThrow(
      new TypeError(
        'Bugsee.showReportDialog requires description to be a string, got number',
      ),
    );
    for (const bad of [null, {}, []]) {
      expect(() => Bugsee.showReportDialog(bad as never)).toThrow(TypeError);
      expect(() => Bugsee.showReportDialog('ok', bad as never)).toThrow(
        TypeError,
      );
    }
    expect(native.showReportDialog).not.toHaveBeenCalled();
  });

  it("severity and labels are validated as upload's", () => {
    expect(() =>
      Bugsee.showReportDialog('s', 'd', 0 as unknown as IssueSeverity),
    ).toThrow(RangeError);
    expect(() =>
      Bugsee.showReportDialog('s', 'd', 6 as unknown as IssueSeverity),
    ).toThrow(RangeError);
    expect(() =>
      Bugsee.showReportDialog('s', 'd', 2.5 as unknown as IssueSeverity),
    ).toThrow(RangeError);
    expect(() =>
      Bugsee.showReportDialog('s', 'd', 'high' as unknown as IssueSeverity),
    ).toThrow(TypeError);
    expect(() =>
      Bugsee.showReportDialog(
        's',
        'd',
        IssueSeverity.High,
        'nope' as unknown as string[],
      ),
    ).toThrow(TypeError);
    expect(() =>
      Bugsee.showReportDialog('s', 'd', IssueSeverity.High, [1] as never),
    ).toThrow(TypeError);
    const secret = 'SECRET_DIALOG_LABEL';
    expect(() =>
      Bugsee.showReportDialog('s', 'd', IssueSeverity.High, [secret, 1] as never),
    ).toThrow(TypeError);
    try {
      Bugsee.showReportDialog('s', 'd', IssueSeverity.High, [secret, 1] as never);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
    expect(native.showReportDialog).not.toHaveBeenCalled();
  });
});
