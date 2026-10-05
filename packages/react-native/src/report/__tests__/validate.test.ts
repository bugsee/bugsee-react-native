import { BugseeReportError, ReportErrorCode } from '../errors';
import { normalizeFilePath, validateSeverity } from '../validate';

describe('validateSeverity', () => {
  it('rejects with a fixed message, never the value', () => {
    for (const value of [0, 6, 2.5, '3', 's3cret', null, undefined]) {
      expect(() => validateSeverity(value)).toThrow(
        new BugseeReportError(ReportErrorCode.BadArgument, 'severity must be an integer 1..5'),
      );
    }
  });
});

describe('normalizeFilePath', () => {
  it('rejects invalid percent-encoding with a fixed message, never the path', () => {
    expect(() => normalizeFilePath('file:///private/s3cret-user/%E0%A4%A')).toThrow(
      new BugseeReportError(ReportErrorCode.BadArgument, 'path is not valid percent-encoding'),
    );
  });
});

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
