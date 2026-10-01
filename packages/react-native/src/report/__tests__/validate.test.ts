import { BugseeReportError, ReportErrorCode } from '../errors';

describe('ReportErrorCode', () => {
  it('ReportErrorCode values are exactly the four stable strings', () => {
    expect(Object.values(ReportErrorCode).sort()).toEqual(
      [
        'E_REPORT_ATTACHMENT_REJECTED',
        'E_REPORT_BAD_ARGUMENT',
        'E_REPORT_CREATE_BUSY',
        'E_REPORT_HANDLE_DEAD',
      ].sort(),
    );
  });
});

describe('BugseeReportError', () => {
  it('carries its code and message, and names itself', () => {
    const error = new BugseeReportError(ReportErrorCode.BadArgument, 'nope');

    expect(error.code).toBe(ReportErrorCode.BadArgument);
    expect(error.message).toBe('nope');
    expect(error.name).toBe('BugseeReportError');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(BugseeReportError);
  });
});
