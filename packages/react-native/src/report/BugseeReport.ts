import NativeBugsee from '../NativeBugsee';
import type { IssueSeverity } from '../options/enums';
import { BugseeReportError, ReportErrorCode } from './errors';
import type {
  BugseeReport,
  BugseeReportSnapshot,
  ReportPatch,
  ReportType,
} from './types';
import {
  normalizeFilePath,
  severityFromNative,
  validateBase64,
  validateNonEmptyString,
  validateReportPatch,
} from './validate';

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.values(ReportErrorCode),
);

/**
 * Translates a native rejection into a `BugseeReportError` carrying the same
 * `.code`, so a caller can match on `.code` no matter which side raised it.
 * Anything else -- a rejection with no recognised code -- passes through
 * unchanged rather than being reinterpreted as something it is not.
 */
function toReportError(error: unknown): unknown {
  if (error instanceof BugseeReportError) {
    return error;
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code)) {
    const message = (error as { message?: unknown }).message;
    return new BugseeReportError(
      code as ReportErrorCode,
      typeof message === 'string' ? message : code,
    );
  }
  return error;
}

function emptySnapshot(): BugseeReportSnapshot {
  return {
    summary: undefined,
    description: undefined,
    severity: undefined,
    labels: [],
    attributes: {},
    screenshotDisplayIds: [],
    attachmentNames: [],
  };
}

function normalizeSnapshot(raw: unknown): BugseeReportSnapshot {
  if (typeof raw !== 'object' || raw === null) {
    return emptySnapshot();
  }
  const source = raw as Record<string, unknown>;

  const attributes: Record<string, string | number | boolean> = {};
  const rawAttributes = source.attributes;
  if (typeof rawAttributes === 'object' && rawAttributes !== null) {
    for (const [key, value] of Object.entries(
      rawAttributes as Record<string, unknown>,
    )) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        // Defined, not assigned: `attributes["__proto__"] = value` would hit
        // Object.prototype's setter and drop the attribute. The object itself
        // stays ordinary (hasOwnProperty, toString): callers get it as-is.
        Object.defineProperty(attributes, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  }

  const screenshotDisplayIds = Array.isArray(source.screenshotDisplayIds)
    ? [...(source.screenshotDisplayIds as number[])].sort((a, b) => a - b)
    : [];

  const summary = source.summary;
  const description = source.description;

  return {
    summary: typeof summary === 'string' ? summary : undefined,
    description: typeof description === 'string' ? description : undefined,
    severity: severityFromNative(source.severity),
    labels: Array.isArray(source.labels) ? [...(source.labels as string[])] : [],
    attributes,
    screenshotDisplayIds,
    attachmentNames: Array.isArray(source.attachmentNames)
      ? [...(source.attachmentNames as string[])]
      : [],
  };
}

/**
 * The live `BugseeReport` handed to a `BugseeReportHandler` callback.
 *
 * One instance per delivered event -- two `onAfterReportCreated` calls for
 * the same report get two independent proxies, each scoped to its own
 * `handleId`. `markDead()` is not part of the public `BugseeReport` contract;
 * only the dispatcher, which owns this proxy's lifetime, calls it.
 */
export class BugseeReportProxy implements BugseeReport {
  readonly id: string;
  readonly type: ReportType;
  private readonly handleId: string;
  private dead = false;

  constructor(handleId: string, id: string, type: ReportType) {
    this.handleId = handleId;
    this.id = id;
    this.type = type;
  }

  /**
   * Marks this handle dead. Every operation after this rejects locally with
   * `E_REPORT_HANDLE_DEAD` without crossing the bridge. Called by the
   * dispatcher exactly once per handle -- when the callback that received
   * this report settles, or when its deadline passes first.
   */
  markDead(): void {
    this.dead = true;
  }

  private ensureAlive(): void {
    if (this.dead) {
      throw new BugseeReportError(
        ReportErrorCode.HandleDead,
        'This BugseeReport handle is no longer valid: its handler has ' +
          'already settled, or its deadline has passed.',
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
      NativeBugsee.reportRead(this.handleId),
    );
    return normalizeSnapshot(raw);
  }

  async getSummary(): Promise<string | undefined> {
    return (await this.read()).summary;
  }

  async setSummary(value: string | null): Promise<void> {
    await this.update({ summary: value });
  }

  async getDescription(): Promise<string | undefined> {
    return (await this.read()).description;
  }

  async setDescription(value: string | null): Promise<void> {
    await this.update({ description: value });
  }

  async getSeverity(): Promise<IssueSeverity | undefined> {
    return (await this.read()).severity;
  }

  async setSeverity(value: IssueSeverity): Promise<void> {
    await this.update({ severity: value });
  }

  async getLabels(): Promise<string[]> {
    return (await this.read()).labels;
  }

  async setLabels(labels: readonly string[]): Promise<void> {
    await this.update({ labels });
  }

  async getAttributes(): Promise<Record<string, string | number | boolean>> {
    return (await this.read()).attributes;
  }

  async setAttribute(
    name: string,
    value: string | number | boolean | null,
  ): Promise<void> {
    await this.update({ attributes: { [name]: value } });
  }

  async clearAttributes(): Promise<void> {
    await this.update({ clearAttributes: true });
  }

  async getScreenshotDisplayIds(): Promise<number[]> {
    return (await this.read()).screenshotDisplayIds;
  }

  async getAttachmentNames(): Promise<string[]> {
    return (await this.read()).attachmentNames;
  }

  async addFileAttachment(
    path: string,
    options: { name: string; mimeType?: string; move?: boolean },
  ): Promise<void> {
    this.ensureAlive();
    const normalizedPath = normalizeFilePath(
      validateNonEmptyString(path, 'path'),
    );
    validateNonEmptyString(normalizedPath, 'path');
    const name = validateNonEmptyString(options?.name, 'name');
    await this.callNative(() =>
      NativeBugsee.reportAddFileAttachment(
        this.handleId,
        normalizedPath,
        name,
        options?.mimeType ?? null,
        options?.move ?? false,
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
      NativeBugsee.reportAddDataAttachment(
        this.handleId,
        validBase64,
        name,
        options?.mimeType ?? null,
      ),
    );
  }

  async update(patch: ReportPatch): Promise<void> {
    this.ensureAlive();
    // Validated in full before anything crosses the bridge: a patch with one
    // bad field must send nothing, not everything except that field.
    const wire = validateReportPatch(patch);
    await this.callNative(() => NativeBugsee.reportUpdate(this.handleId, wire));
  }
}
