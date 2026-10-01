// The package entry reads Platform.OS. Mocked to a known platform; this suite
// is about createReport, not about which one.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import Bugsee, { BugseeReportError, IssueSeverity, ReportErrorCode } from '../../index';
import { jsonOf, native } from '../../__mocks__/native';

jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

beforeEach(() => native.reset());

async function opened(handle = 'cr-1') {
  native.createReport.mockResolvedValueOnce(handle);
  const report = await Bugsee.createReport();
  if (report === null) {
    throw new Error(`expected createReport to wrap ${handle}`);
  }
  return report;
}

describe('createReport', () => {
  it('createReport resolves null when native made none', async () => {
    native.createReport.mockResolvedValueOnce(null);

    await expect(Bugsee.createReport()).resolves.toBeNull();
  });

  it('createReport wraps a handle', async () => {
    native.createReport.mockResolvedValueOnce('cr-7');
    native.createdReportRead.mockResolvedValueOnce({ summary: 'kept' });

    const report = await Bugsee.createReport();

    expect(report).not.toBeNull();
    await expect(report!.read()).resolves.toMatchObject({ summary: 'kept' });
    expect(native.createdReportRead).toHaveBeenCalledTimes(1);
    expect(native.createdReportRead).toHaveBeenCalledWith('cr-7');
  });

  it('E_REPORT_CREATE_BUSY surfaces as BugseeReportError with its code', async () => {
    native.createReport.mockRejectedValueOnce({
      code: 'E_REPORT_CREATE_BUSY',
      message: 'a created report is already outstanding',
    });

    const error = await Bugsee.createReport().then(
      () => {
        throw new Error('expected createReport to reject');
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BugseeReportError);
    expect(error).toMatchObject({
      code: ReportErrorCode.CreateBusy,
      message: 'a created report is already outstanding',
    });
  });
});

describe('CreatedReport', () => {
  it('update sends the validated patch as JSON', async () => {
    const report = await opened();
    native.createdReportUpdate.mockResolvedValueOnce(undefined);

    await report.update({
      summary: 'new summary',
      description: null,
      severity: IssueSeverity.Blocker,
      labels: ['x', 'y'],
      clearAttributes: true,
      attributes: { a: 1, b: null },
    });

    expect(native.createdReportUpdate).toHaveBeenCalledTimes(1);
    expect(native.createdReportUpdate).toHaveBeenCalledWith(
      'cr-1',
      jsonOf({
        summary: 'new summary',
        description: null,
        severity: IssueSeverity.Blocker,
        labels: ['x', 'y'],
        clearAttributes: true,
        attributes: { a: 1, b: null },
      }),
    );
  });

  it('update with one bad field sends nothing', async () => {
    const report = await opened();

    await expect(
      report.update({ summary: 'ok', severity: 999 as IssueSeverity }),
    ).rejects.toMatchObject({ code: ReportErrorCode.BadArgument });
    expect(native.createdReportUpdate).not.toHaveBeenCalled();
  });

  it('addFileAttachment strips file:// and sends no move', async () => {
    const report = await opened();
    native.createdReportAddFileAttachment.mockResolvedValueOnce(undefined);

    await report.addFileAttachment('file:///a%20b.png', {
      name: 'shot',
      mimeType: 'image/png',
    });

    expect(native.createdReportAddFileAttachment).toHaveBeenCalledTimes(1);
    expect(native.createdReportAddFileAttachment).toHaveBeenCalledWith(
      'cr-1',
      '/a b.png',
      'shot',
      'image/png',
    );
    expect(native.createdReportAddFileAttachment.mock.calls[0]).toHaveLength(4);
    expect(native.reportAddFileAttachment).not.toHaveBeenCalled();
  });

  it('addDataAttachment rejects non-base64 before crossing', async () => {
    const report = await opened();

    await expect(
      report.addDataAttachment('not base64!!', { name: 'x' }),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/base64-encoded/),
    });
    expect(native.createdReportAddDataAttachment).not.toHaveBeenCalled();
  });

  it("upload resolves native's result", async () => {
    const yes = await opened('cr-yes');
    native.createdReportUpload.mockResolvedValueOnce(true);
    await expect(yes.upload()).resolves.toBe(true);
    expect(native.createdReportUpload).toHaveBeenCalledWith('cr-yes');

    const no = await opened('cr-no');
    native.createdReportUpload.mockResolvedValueOnce(false);
    await expect(no.upload()).resolves.toBe(false);
    expect(native.createdReportUpload).toHaveBeenLastCalledWith('cr-no');
  });

  it('after upload every op rejects E_REPORT_HANDLE_DEAD without crossing', async () => {
    const report = await opened();
    native.createdReportUpload.mockResolvedValueOnce(true);
    await report.upload();

    native.createdReportRead.mockClear();
    native.createdReportUpdate.mockClear();
    native.createdReportAddFileAttachment.mockClear();
    native.createdReportAddDataAttachment.mockClear();
    native.createdReportUpload.mockClear();

    await expect(report.read()).rejects.toMatchObject({
      code: ReportErrorCode.HandleDead,
    });
    await expect(report.update({ summary: 'later' })).rejects.toMatchObject({
      code: ReportErrorCode.HandleDead,
    });
    await expect(
      report.addFileAttachment('/a.png', { name: 'a' }),
    ).rejects.toMatchObject({ code: ReportErrorCode.HandleDead });
    await expect(
      report.addDataAttachment('YWJj', { name: 'b' }),
    ).rejects.toMatchObject({ code: ReportErrorCode.HandleDead });
    await expect(report.upload()).rejects.toMatchObject({
      code: ReportErrorCode.HandleDead,
    });

    expect(native.createdReportRead).not.toHaveBeenCalled();
    expect(native.createdReportUpdate).not.toHaveBeenCalled();
    expect(native.createdReportAddFileAttachment).not.toHaveBeenCalled();
    expect(native.createdReportAddDataAttachment).not.toHaveBeenCalled();
    expect(native.createdReportUpload).not.toHaveBeenCalled();
  });

  it('two concurrent upload calls cross once', async () => {
    const report = await opened();
    let release: (value: boolean) => void = () => {};
    native.createdReportUpload.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );

    const first = report.upload();
    const second = report.upload();

    expect(native.createdReportUpload).toHaveBeenCalledTimes(1);
    release(true);
    await expect(first).resolves.toBe(true);
    await expect(second).rejects.toMatchObject({
      code: ReportErrorCode.HandleDead,
    });
    expect(native.createdReportUpload).toHaveBeenCalledTimes(1);
  });

  it('read normalises the snapshot as the handler proxy does', async () => {
    const report = await opened();
    native.createdReportRead.mockResolvedValueOnce({
      summary: 'a summary',
      description: null,
      severity: 4,
      labels: ['a', 'b'],
      attributes: { flag: true, count: 3, name: 'x', dropped: { nested: true } },
      screenshotDisplayIds: [2, 1],
      attachmentNames: ['shot.png'],
    });

    await expect(report.read()).resolves.toEqual({
      summary: 'a summary',
      description: undefined,
      severity: IssueSeverity.Critical,
      labels: ['a', 'b'],
      attributes: { flag: true, count: 3, name: 'x' },
      screenshotDisplayIds: [1, 2],
      attachmentNames: ['shot.png'],
    });
  });
});
