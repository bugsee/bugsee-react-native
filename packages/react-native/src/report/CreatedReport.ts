import NativeBugsee from '../NativeBugsee';
import { encodeBridgeObject } from '../bridge/json';
import { normalizeSnapshot, toReportError } from './BugseeReport';
import { BugseeReportError, ReportErrorCode } from './errors';
import type { BugseeCreatedReport, BugseeReportSnapshot, ReportPatch } from './types';
import {
  normalizeFilePath,
  validateBase64,
  validateNonEmptyString,
  validateReportPatch,
} from './validate';

/**
 * The live `BugseeCreatedReport` `createReport()` hands back.
 *
 * One instance per handle. `upload()` marks it dead synchronously, before the
 * call crosses, so a second `upload()` rejects locally and the bridge sees
 * the first call only.
 */
export class CreatedReport implements BugseeCreatedReport {
  private readonly handleId: string;
  private dead = false;

  constructor(handleId: string) {
    this.handleId = handleId;
  }

  private ensureAlive(): void {
    if (this.dead) {
      throw new BugseeReportError(
        ReportErrorCode.HandleDead,
        'This created report handle is no longer valid: upload() has already been called.',
      );
    }
  }

  private async callNative<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toReportError(error);
    }
  }

  async read(): Promise<BugseeReportSnapshot> {
    this.ensureAlive();
    const raw = await this.callNative(() =>
      NativeBugsee.createdReportRead(this.handleId),
    );
    return normalizeSnapshot(raw);
  }

  async update(patch: ReportPatch): Promise<void> {
    this.ensureAlive();
    // Validated in full before anything crosses the bridge: a patch with one
    // bad field must send nothing, not everything except that field. Then
    // sent as JSON text, the only form in which a clearing `null` survives
    // iOS's TurboModule argument conversion.
    const wire = encodeBridgeObject(validateReportPatch(patch));
    await this.callNative(() =>
      NativeBugsee.createdReportUpdate(this.handleId, wire),
    );
  }

  async addFileAttachment(
    path: string,
    options: { name: string; mimeType?: string },
  ): Promise<void> {
    this.ensureAlive();
    const normalizedPath = normalizeFilePath(
      validateNonEmptyString(path, 'path'),
    );
    validateNonEmptyString(normalizedPath, 'path');
    const name = validateNonEmptyString(options?.name, 'name');
    await this.callNative(() =>
      NativeBugsee.createdReportAddFileAttachment(
        this.handleId,
        normalizedPath,
        name,
        options?.mimeType ?? null,
      ),
    );
  }

  async addDataAttachment(
    base64: string,
    options: { name: string; mimeType?: string },
  ): Promise<void> {
    this.ensureAlive();
    const validBase64 = validateBase64(base64);
    const name = validateNonEmptyString(options?.name, 'name');
    await this.callNative(() =>
      NativeBugsee.createdReportAddDataAttachment(
        this.handleId,
        validBase64,
        name,
        options?.mimeType ?? null,
      ),
    );
  }

  async upload(): Promise<boolean> {
    this.ensureAlive();
    // Before the call, not after it resolves: two overlapping upload() calls
    // must cross once. The handle stays dead whatever the native result is.
    this.dead = true;
    return this.callNative(() => NativeBugsee.createdReportUpload(this.handleId));
  }
}

/**
 * Asks native for a created report and wraps the handle it mints.
 * `null` is "the SDK made none". A native `E_REPORT_CREATE_BUSY` (and any
 * other known report code) comes back as a `BugseeReportError`.
 */
export async function createReport(): Promise<BugseeCreatedReport | null> {
  let handleId: string | null;
  try {
    handleId = await NativeBugsee.createReport();
  } catch (error) {
    throw toReportError(error);
  }
  if (handleId == null) {
    return null;
  }
  return new CreatedReport(handleId);
}
