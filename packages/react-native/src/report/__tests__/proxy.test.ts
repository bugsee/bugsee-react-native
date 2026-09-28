jest.mock('../../NativeBugsee', () => require('../../__mocks__/native').nativeMock);

import { native } from '../../__mocks__/native';
import { IssueSeverity } from '../../options/enums';
import { BugseeReportProxy } from '../BugseeReport';
import { BugseeReportError, ReportErrorCode } from '../errors';

beforeEach(() => native.reset());

/** A raw `reportRead` snapshot, native-shaped, with the report handler's defaults. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: null,
    description: null,
    severity: 0,
    labels: [],
    attributes: {},
    screenshotDisplayIds: [],
    attachmentNames: [],
    ...overrides,
  };
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('a dead proxy', () => {
  it('ops after completion reject with E_REPORT_HANDLE_DEAD without crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    report.markDead();

    await expect(report.getSummary()).rejects.toMatchObject({
      code: ReportErrorCode.HandleDead,
      message: expect.stringMatching(/no longer valid[\s\S]*deadline has passed/i),
    });
    await expect(report.setSeverity(IssueSeverity.High)).rejects.toMatchObject({
      code: ReportErrorCode.HandleDead,
    });
    await expect(
      report.addFileAttachment('/a', { name: 'n' }),
    ).rejects.toMatchObject({ code: ReportErrorCode.HandleDead });
    await expect(
      report.addDataAttachment('YWJj', { name: 'n' }),
    ).rejects.toMatchObject({ code: ReportErrorCode.HandleDead });

    expect(native.reportRead).not.toHaveBeenCalled();
    expect(native.reportUpdate).not.toHaveBeenCalled();
    expect(native.reportAddFileAttachment).not.toHaveBeenCalled();
    expect(native.reportAddDataAttachment).not.toHaveBeenCalled();
  });
});

describe('native rejections', () => {
  it('passes an already-BugseeReportError through unchanged', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    const original = new BugseeReportError(ReportErrorCode.BadArgument, 'already wrapped');
    native.reportRead.mockRejectedValueOnce(original);

    const error = await captureError(() => report.read());

    expect(error).toBe(original);
  });

  it('a native E_REPORT_HANDLE_DEAD surfaces with the same code', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportRead.mockRejectedValueOnce(
      Object.assign(new Error('handle is gone'), {
        code: ReportErrorCode.HandleDead,
      }),
    );

    const error = await captureError(() => report.read());

    expect(error).toBeInstanceOf(BugseeReportError);
    expect((error as BugseeReportError).code).toBe(ReportErrorCode.HandleDead);
  });

  it('E_REPORT_ATTACHMENT_REJECTED surfaces with its code', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportAddFileAttachment.mockRejectedValueOnce(
      Object.assign(new Error('native declined the attachment'), {
        code: ReportErrorCode.AttachmentRejected,
      }),
    );

    const error = await captureError(() =>
      report.addFileAttachment('/ok.png', { name: 'ok' }),
    );

    expect(error).toBeInstanceOf(BugseeReportError);
    expect((error as BugseeReportError).code).toBe(
      ReportErrorCode.AttachmentRejected,
    );
  });
});

describe('severity', () => {
  it('severity 0 reads as undefined', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportRead.mockResolvedValueOnce(snapshot({ severity: 0 }));

    await expect(report.getSeverity()).resolves.toBeUndefined();
  });

  it('severity 7 reads as undefined', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportRead.mockResolvedValueOnce(snapshot({ severity: 7 }));

    await expect(report.getSeverity()).resolves.toBeUndefined();
  });

  it('severity 4 reads as IssueSeverity.Critical', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportRead.mockResolvedValueOnce(snapshot({ severity: 4 }));

    await expect(report.getSeverity()).resolves.toBe(IssueSeverity.Critical);
  });

  it.each([0, 6, 2.5, NaN])(
    'setSeverity rejects %p before crossing',
    async (value) => {
      const report = new BugseeReportProxy('h1', 'r1', 'bug');

      await expect(
        report.setSeverity(value as IssueSeverity),
      ).rejects.toMatchObject({
        code: ReportErrorCode.BadArgument,
        message: expect.stringMatching(/integer 1\.\.5/),
      });
      expect(native.reportUpdate).not.toHaveBeenCalled();
    },
  );

  it('setSeverity accepts the lower boundary, 1 (VeryLow)', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportUpdate.mockResolvedValueOnce(undefined);

    await report.setSeverity(IssueSeverity.VeryLow);

    expect(native.reportUpdate).toHaveBeenCalledWith('h1', {
      severity: IssueSeverity.VeryLow,
    });
  });
});

describe('labels', () => {
  it('setLabels sends the whole list in one reportUpdate', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportUpdate.mockResolvedValueOnce(undefined);

    await report.setLabels(['a', 'b']);

    expect(native.reportUpdate).toHaveBeenCalledTimes(1);
    expect(native.reportUpdate).toHaveBeenCalledWith('h1', { labels: ['a', 'b'] });
  });

  it('setLabels rejects a non-string label before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.setLabels(['a', 42 as unknown as string]),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/must all be strings/),
    });
    expect(native.reportUpdate).not.toHaveBeenCalled();
  });
});

describe('attributes', () => {
  it('setAttribute(name, null) sends a removal', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportUpdate.mockResolvedValueOnce(undefined);

    await report.setAttribute('foo', null);

    expect(native.reportUpdate).toHaveBeenCalledWith('h1', {
      attributes: { foo: null },
    });
  });

  it.each([NaN, Infinity, {}])(
    'setAttribute rejects %p before crossing',
    async (value) => {
      const report = new BugseeReportProxy('h1', 'r1', 'bug');

      await expect(
        report.setAttribute('foo', value as never),
      ).rejects.toMatchObject({
        code: ReportErrorCode.BadArgument,
        message: expect.stringMatching(/string, boolean, finite number or null/),
      });
      expect(native.reportUpdate).not.toHaveBeenCalled();
    },
  );

  it('setAttribute accepts a plain string value', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportUpdate.mockResolvedValueOnce(undefined);

    await report.setAttribute('name', 'value');

    expect(native.reportUpdate).toHaveBeenCalledWith('h1', {
      attributes: { name: 'value' },
    });
  });
});

describe('update', () => {
  it('update with one bad field sends nothing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.update({ summary: 'ok', severity: 999 as IssueSeverity }),
    ).rejects.toMatchObject({ code: ReportErrorCode.BadArgument });
    expect(native.reportUpdate).not.toHaveBeenCalled();
  });
});

describe('addFileAttachment', () => {
  it('strips file:// and percent-decodes', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportAddFileAttachment.mockResolvedValueOnce(undefined);

    await report.addFileAttachment('file:///a%20b.png', { name: 'shot' });

    expect(native.reportAddFileAttachment).toHaveBeenCalledWith(
      'h1',
      '/a b.png',
      'shot',
      null,
      false,
    );
  });

  it.each([
    ['', 'name', 'path'],
    ['/ok/path', '', 'name'],
  ] as const)('rejects an empty path or name (%p, %p)', async (path, name, field) => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.addFileAttachment(path, { name }),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(new RegExp(`^${field} must be a non-empty string$`)),
    });
    expect(native.reportAddFileAttachment).not.toHaveBeenCalled();
  });

  it('rejects a bare "file://" that normalizes to an empty path', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.addFileAttachment('file://', { name: 'n' }),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/^path must be a non-empty string$/),
    });
    expect(native.reportAddFileAttachment).not.toHaveBeenCalled();
  });

  it('rejects a non-string path before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.addFileAttachment(123 as unknown as string, { name: 'n' }),
    ).rejects.toMatchObject({ code: ReportErrorCode.BadArgument });
    expect(native.reportAddFileAttachment).not.toHaveBeenCalled();
  });

  it('rejects options being absent entirely, before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.addFileAttachment(
        '/ok.png',
        undefined as unknown as { name: string },
      ),
    ).rejects.toMatchObject({ code: ReportErrorCode.BadArgument });
    expect(native.reportAddFileAttachment).not.toHaveBeenCalled();
  });
});

describe('addDataAttachment', () => {
  it.each(['not base64!!', 'abc', 'ab=c'])(
    'rejects non-base64 %p before crossing',
    async (data) => {
      const report = new BugseeReportProxy('h1', 'r1', 'bug');

      await expect(
        report.addDataAttachment(data, { name: 'x' }),
      ).rejects.toMatchObject({
        code: ReportErrorCode.BadArgument,
        message: expect.stringMatching(/base64-encoded/),
      });
      expect(native.reportAddDataAttachment).not.toHaveBeenCalled();
    },
  );

  it('rejects a non-string data value before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.addDataAttachment(123 as unknown as string, { name: 'x' }),
    ).rejects.toMatchObject({ code: ReportErrorCode.BadArgument });
    expect(native.reportAddDataAttachment).not.toHaveBeenCalled();
  });

  // A boxed String is not a `string` (typeof is "object"), but it has a
  // `.length` and stringifies to something the base64 pattern accepts, so it
  // slips past a length or pattern check alone -- only the `typeof` check
  // catches it.
  it('rejects a boxed String even though it looks base64-shaped', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.addDataAttachment(new String('YWJj') as unknown as string, {
        name: 'x',
      }),
    ).rejects.toMatchObject({ code: ReportErrorCode.BadArgument });
    expect(native.reportAddDataAttachment).not.toHaveBeenCalled();
  });
});

describe('getScreenshotDisplayIds', () => {
  it('is ascending even when native is not', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportRead.mockResolvedValueOnce(
      snapshot({ screenshotDisplayIds: [5, 1, 3] }),
    );

    await expect(report.getScreenshotDisplayIds()).resolves.toEqual([1, 3, 5]);
  });
});

describe('id and type', () => {
  it('are synchronous and come from the event', () => {
    const report = new BugseeReportProxy('handle-1', 'report-77', 'crash');

    expect(report.id).toBe('report-77');
    expect(report.type).toBe('crash');
  });
});

describe('read', () => {
  it('normalizes a full, well-formed snapshot field for field', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportRead.mockResolvedValueOnce({
      summary: 'a summary',
      description: 'a description',
      severity: 4,
      labels: ['a', 'b'],
      attributes: { flag: true, count: 3, name: 'x' },
      screenshotDisplayIds: [2, 1],
      attachmentNames: ['shot.png'],
    });

    await expect(report.read()).resolves.toEqual({
      summary: 'a summary',
      description: 'a description',
      severity: IssueSeverity.Critical,
      labels: ['a', 'b'],
      attributes: { flag: true, count: 3, name: 'x' },
      screenshotDisplayIds: [1, 2],
      attachmentNames: ['shot.png'],
    });
  });

  it.each([null, 'oops', 42])(
    'treats a non-object raw snapshot (%p) as empty',
    async (raw) => {
      const report = new BugseeReportProxy('h1', 'r1', 'bug');
      native.reportRead.mockResolvedValueOnce(raw);

      await expect(report.read()).resolves.toEqual({
        summary: undefined,
        description: undefined,
        severity: undefined,
        labels: [],
        attributes: {},
        screenshotDisplayIds: [],
        attachmentNames: [],
      });
    },
  );

  it('treats a function raw snapshot as empty, even one carrying properties', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    // typeof a function is 'function', not 'object' -- so `read()` must
    // reject it as raw, even though (unlike a string or number) a function
    // can genuinely carry a `summary` property that would otherwise leak
    // through if the type guard were dropped.
    const sneaky = Object.assign(() => {}, { summary: 'sneaky' });
    native.reportRead.mockResolvedValueOnce(sneaky);

    await expect(report.read()).resolves.toEqual(
      expect.objectContaining({ summary: undefined }),
    );
  });

  it.each(['summary', 'description'])(
    'reads a non-string %s as undefined',
    async (field) => {
      const report = new BugseeReportProxy('h1', 'r1', 'bug');
      native.reportRead.mockResolvedValueOnce(snapshot({ [field]: 42 }));

      const result = await report.read();
      expect(result[field as 'summary' | 'description']).toBeUndefined();
    },
  );

  it.each(['labels', 'attachmentNames', 'screenshotDisplayIds'])(
    'reads a non-array %s as empty',
    async (field) => {
      const report = new BugseeReportProxy('h1', 'r1', 'bug');
      native.reportRead.mockResolvedValueOnce(snapshot({ [field]: 'oops' }));

      const result = await report.read();
      expect(
        result[field as 'labels' | 'attachmentNames' | 'screenshotDisplayIds'],
      ).toEqual([]);
    },
  );

  it.each(['oops', null, 42])(
    'reads a non-object attributes (%p) as empty',
    async (attributes) => {
      const report = new BugseeReportProxy('h1', 'r1', 'bug');
      native.reportRead.mockResolvedValueOnce(snapshot({ attributes }));

      await expect(report.read()).resolves.toEqual(
        expect.objectContaining({ attributes: {} }),
      );
    },
  );

  it('drops a non-primitive attribute value', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportRead.mockResolvedValueOnce(
      snapshot({ attributes: { good: 'x', bad: { nested: true } } }),
    );

    await expect(report.read()).resolves.toEqual(
      expect.objectContaining({ attributes: { good: 'x' } }),
    );
  });

  it('getSummary, getDescription, getSeverity, getLabels, getAttributes, getScreenshotDisplayIds and getAttachmentNames are all sugar over read()', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportRead.mockResolvedValue({
      summary: 'sum',
      description: 'desc',
      severity: IssueSeverity.High,
      labels: ['a'],
      attributes: { k: 'v' },
      screenshotDisplayIds: [3, 1],
      attachmentNames: ['n.png'],
    });

    await expect(report.getSummary()).resolves.toBe('sum');
    await expect(report.getDescription()).resolves.toBe('desc');
    await expect(report.getSeverity()).resolves.toBe(IssueSeverity.High);
    await expect(report.getLabels()).resolves.toEqual(['a']);
    await expect(report.getAttributes()).resolves.toEqual({ k: 'v' });
    await expect(report.getScreenshotDisplayIds()).resolves.toEqual([1, 3]);
    await expect(report.getAttachmentNames()).resolves.toEqual(['n.png']);
  });
});

describe('native error translation', () => {
  it('falls back to the code as the message when native gives none', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportRead.mockRejectedValueOnce({ code: ReportErrorCode.HandleDead });

    const error = await captureError(() => report.read());

    expect(error).toBeInstanceOf(BugseeReportError);
    expect((error as BugseeReportError).message).toBe(ReportErrorCode.HandleDead);
  });

  it('keeps the native message when one is given', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportRead.mockRejectedValueOnce(
      Object.assign(new Error('native said no'), {
        code: ReportErrorCode.AttachmentRejected,
      }),
    );

    const error = await captureError(() => report.read());

    expect((error as BugseeReportError).message).toBe('native said no');
  });

  it('passes a rejection with no code through unchanged, even null or undefined', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportRead.mockRejectedValueOnce(null);

    const error = await captureError(() => report.read());

    expect(error).toBeNull();
  });

  it('passes an unrecognised code through unchanged', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    const original = Object.assign(new Error('some other native failure'), {
      code: 'E_SOMETHING_ELSE',
    });
    native.reportRead.mockRejectedValueOnce(original);

    const error = await captureError(() => report.read());

    expect(error).toBe(original);
  });
});

describe('clearAttributes', () => {
  it('sends clearAttributes: true in one reportUpdate', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportUpdate.mockResolvedValueOnce(undefined);

    await report.clearAttributes();

    expect(native.reportUpdate).toHaveBeenCalledWith('h1', {
      clearAttributes: true,
    });
  });
});

describe('setDescription', () => {
  it('sends the description in one reportUpdate', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportUpdate.mockResolvedValueOnce(undefined);

    await report.setDescription('a new description');

    expect(native.reportUpdate).toHaveBeenCalledWith('h1', {
      description: 'a new description',
    });
  });

  it('rejects a non-string, non-null description before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.update({ description: 42 as unknown as string }),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/description must be a string or null/),
    });
    expect(native.reportUpdate).not.toHaveBeenCalled();
  });
});

describe('update', () => {
  it('forwards a full patch, every field, in one reportUpdate call', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportUpdate.mockResolvedValueOnce(undefined);

    await report.update({
      summary: 'new summary',
      description: null,
      severity: IssueSeverity.Blocker,
      labels: ['x', 'y'],
      clearAttributes: true,
      attributes: { a: 1, b: null },
    });

    expect(native.reportUpdate).toHaveBeenCalledTimes(1);
    expect(native.reportUpdate).toHaveBeenCalledWith('h1', {
      summary: 'new summary',
      description: null,
      severity: IssueSeverity.Blocker,
      labels: ['x', 'y'],
      clearAttributes: true,
      attributes: { a: 1, b: null },
    });
  });

  it('rejects an unknown key before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.update({ typo: 'x' } as unknown as Parameters<
        BugseeReportProxy['update']
      >[0]),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/unknown key "typo"/),
    });
    expect(native.reportUpdate).not.toHaveBeenCalled();
  });

  it('rejects clearAttributes: false before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.update({ clearAttributes: false as unknown as true }),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/clearAttributes must be true/),
    });
    expect(native.reportUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['a string', 'not an object'],
    ['an array', ['not', 'an', 'object']],
    ['null', null],
  ])('rejects attributes that are %s before crossing', async (_label, value) => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.update({ attributes: value as unknown as Record<string, string> }),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/plain object/),
    });
    expect(native.reportUpdate).not.toHaveBeenCalled();
  });

  it('rejects a patch that is a string, not an object', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.update('nope' as unknown as Parameters<BugseeReportProxy['update']>[0]),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/requires a patch object/),
    });
    expect(native.reportUpdate).not.toHaveBeenCalled();
  });

  it('rejects a null patch', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.update(null as unknown as Parameters<BugseeReportProxy['update']>[0]),
    ).rejects.toMatchObject({ code: ReportErrorCode.BadArgument });
    expect(native.reportUpdate).not.toHaveBeenCalled();
  });
});

describe('setSummary', () => {
  it('sends the summary in one reportUpdate', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportUpdate.mockResolvedValueOnce(undefined);

    await report.setSummary('a new summary');

    expect(native.reportUpdate).toHaveBeenCalledWith('h1', {
      summary: 'a new summary',
    });
  });

  it('sends null to clear the summary', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportUpdate.mockResolvedValueOnce(undefined);

    await report.setSummary(null);

    expect(native.reportUpdate).toHaveBeenCalledWith('h1', { summary: null });
  });

  it('rejects a non-string, non-null summary before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.update({ summary: 42 as unknown as string }),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/summary must be a string or null/),
    });
    expect(native.reportUpdate).not.toHaveBeenCalled();
  });
});

describe('setLabels', () => {
  it('rejects a non-array before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.setLabels('not-an-array' as unknown as string[]),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/array of strings/),
    });
    expect(native.reportUpdate).not.toHaveBeenCalled();
  });
});

describe('setAttribute', () => {
  it('accepts a boolean value', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportUpdate.mockResolvedValueOnce(undefined);

    await report.setAttribute('flag', true);

    expect(native.reportUpdate).toHaveBeenCalledWith('h1', {
      attributes: { flag: true },
    });
  });
});

describe('addFileAttachment percent-decoding', () => {
  // Only a file:// URL is percent-encoded. A plain filesystem path is taken
  // verbatim: `%` is a legal filename character, so decoding one would reject
  // `/data/…/100%done.log` and silently turn `/logs/a%41.log` into
  // `/logs/aA.log`.
  it.each([
    ['/data/user/0/app/files/100%done.log'],
    ['/broken%zzpath'],
    ['/logs/a%41.log'],
    ['/logs/a%20b.log'],
  ])('passes a plain path containing %% through verbatim (%p)', async (path) => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportAddFileAttachment.mockResolvedValueOnce(undefined);

    await report.addFileAttachment(path, { name: 'n' });

    expect(native.reportAddFileAttachment).toHaveBeenCalledWith(
      'h1',
      path,
      'n',
      null,
      false,
    );
  });

  it('still decodes a file:// URL', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportAddFileAttachment.mockResolvedValueOnce(undefined);

    await report.addFileAttachment('file:///logs/a%41%25.log', { name: 'n' });

    expect(native.reportAddFileAttachment).toHaveBeenCalledWith(
      'h1',
      '/logs/aA%.log',
      'n',
      null,
      false,
    );
  });

  it('rejects a file:// URL with malformed percent-encoding before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.addFileAttachment('file:///broken%zzpath', { name: 'n' }),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/percent-encoding/),
    });
    expect(native.reportAddFileAttachment).not.toHaveBeenCalled();
  });

  it('passes a path with no file:// prefix through unchanged', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportAddFileAttachment.mockResolvedValueOnce(undefined);

    await report.addFileAttachment('/already/plain.png', {
      name: 'plain',
      mimeType: 'image/png',
      move: true,
    });

    expect(native.reportAddFileAttachment).toHaveBeenCalledWith(
      'h1',
      '/already/plain.png',
      'plain',
      'image/png',
      true,
    );
  });
});

describe('addDataAttachment', () => {
  it('accepts valid base64 and forwards it unchanged', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportAddDataAttachment.mockResolvedValueOnce(undefined);

    // "abc", base64-encoded with no padding -- exercises the zero-padding
    // boundary of the base64 pattern.
    await report.addDataAttachment('YWJj', { name: 'data', mimeType: 'text/plain' });

    expect(native.reportAddDataAttachment).toHaveBeenCalledWith(
      'h1',
      'YWJj',
      'data',
      'text/plain',
    );
  });

  it('accepts valid base64 padded with ==', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');
    native.reportAddDataAttachment.mockResolvedValueOnce(undefined);

    await report.addDataAttachment('YQ==', { name: 'data' });

    expect(native.reportAddDataAttachment).toHaveBeenCalledWith(
      'h1',
      'YQ==',
      'data',
      null,
    );
  });

  it('rejects an empty name before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.addDataAttachment('YWJj', { name: '' }),
    ).rejects.toMatchObject({
      code: ReportErrorCode.BadArgument,
      message: expect.stringMatching(/^name must be a non-empty string$/),
    });
    expect(native.reportAddDataAttachment).not.toHaveBeenCalled();
  });

  it('rejects options being absent entirely, before crossing', async () => {
    const report = new BugseeReportProxy('h1', 'r1', 'bug');

    await expect(
      report.addDataAttachment(
        'YWJj',
        undefined as unknown as { name: string },
      ),
    ).rejects.toMatchObject({ code: ReportErrorCode.BadArgument });
    expect(native.reportAddDataAttachment).not.toHaveBeenCalled();
  });
});
