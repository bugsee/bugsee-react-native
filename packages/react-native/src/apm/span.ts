import NativeBugsee from '../NativeBugsee';
import { encodeBridgeObject } from '../bridge/json';
import {
  BugseeSpanError,
  SpanErrorCode,
  SpanStatus,
  type SpanAttribute,
  type SpanWire,
} from './types';

const NONE = '';

const live = new Map<string, SpanObject>();

function dead(): never {
  throw new BugseeSpanError(
    SpanErrorCode.HandleDead,
    'Bugsee span handle is dead; finish already released it',
  );
}

function assertText(value: unknown, method: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`Bugsee.${method} requires ${field} to be a non-empty string`);
  }
  return value;
}

function assertStatus(status: unknown): SpanStatus {
  if (typeof status !== 'number') {
    throw new TypeError('Bugsee span status must be an integer 0..5');
  }
  if (!Number.isInteger(status) || status < SpanStatus.OK || status > SpanStatus.Unknown) {
    throw new RangeError('Bugsee span status must be an integer 0..5');
  }
  return status as SpanStatus;
}

function assertAttribute(value: unknown): SpanAttribute {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  throw new TypeError('Bugsee span attribute must be a string, a finite number or a boolean');
}

function assertAttributes(
  attributes: unknown,
): Record<string, SpanAttribute> | null {
  if (attributes === undefined) {
    return null;
  }
  if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw new TypeError('Bugsee.startTransaction attributes must be an object');
  }
  const copy: Record<string, SpanAttribute> = Object.create(null);
  for (const key of Object.keys(attributes as Record<string, unknown>)) {
    copy[key] = assertAttribute((attributes as Record<string, unknown>)[key]);
  }
  return copy;
}

function asWire(value: unknown): SpanWire {
  const wire = value as SpanWire;
  return {
    handle: typeof wire.handle === 'string' ? wire.handle : NONE,
    spanId: typeof wire.spanId === 'string' ? wire.spanId : '',
    traceId: typeof wire.traceId === 'string' ? wire.traceId : '',
    operation: typeof wire.operation === 'string' ? wire.operation : '',
    description: typeof wire.description === 'string' ? wire.description : null,
    status: typeof wire.status === 'number' ? wire.status : SpanStatus.OK,
    finished: wire.finished === true,
    attributesJson: typeof wire.attributesJson === 'string' ? wire.attributesJson : '{}',
    ...(typeof wire.name === 'string' ? { name: wire.name, sampled: wire.sampled === true } : {}),
  };
}

function adopt(value: unknown): SpanObject | null {
  const wire = asWire(value);
  if (wire.handle === NONE) {
    return null;
  }
  const existing = live.get(wire.handle);
  if (existing !== undefined) {
    return existing;
  }
  const span = new SpanObject(wire);
  live.set(wire.handle, span);
  return span;
}

function markReleased(handles: readonly string[]): void {
  for (const handle of handles) {
    const span = live.get(handle);
    if (span !== undefined) {
      span.markDead();
    }
    live.delete(handle);
  }
}

/**
 * A span the bridge is holding. `finish` tells native to drop it. A parent
 * finish also drops children the SDK has finished; native reports every
 * handle it released, and those objects die here without another call.
 */
class SpanObject {
  private dead = false;
  private operation: string;
  private description: string | null;
  private status: number;
  private finishedFlag: boolean;
  private attributes: Record<string, SpanAttribute>;
  readonly spanId: string;
  readonly traceId: string;
  /** Set only when the wire is a transaction. */
  readonly transactionName: string | undefined;
  readonly transactionSampled: boolean;

  constructor(private readonly wire: SpanWire) {
    this.spanId = wire.spanId;
    this.traceId = wire.traceId;
    this.operation = wire.operation;
    this.description = wire.description;
    this.status = wire.status;
    this.finishedFlag = wire.finished;
    this.attributes = parseAttributes(wire.attributesJson);
    this.transactionName = typeof wire.name === 'string' ? wire.name : undefined;
    this.transactionSampled = wire.sampled === true;
  }

  /** Native `setName`, which sets the operation on both SDKs. */
  setName(name: string): this {
    this.guard();
    const text = assertText(name, 'setName', 'name');
    NativeBugsee.spanSetName(this.wire.handle, text);
    this.operation = text;
    return this;
  }

  setDescription(description: string | null): this {
    this.guard();
    if (description !== null && typeof description !== 'string') {
      throw new TypeError('Bugsee.setDescription requires a string or null');
    }
    NativeBugsee.spanSetDescription(this.wire.handle, description);
    this.description = description;
    return this;
  }

  setAttribute(key: string, value: SpanAttribute): this {
    this.guard();
    const name = assertText(key, 'setAttribute', 'key');
    const attribute = assertAttribute(value);
    NativeBugsee.spanSetAttribute(this.wire.handle, name, JSON.stringify(attribute));
    this.attributes = { ...this.attributes, [name]: attribute };
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.guard();
    const wire = assertStatus(status);
    NativeBugsee.spanSetStatus(this.wire.handle, wire);
    this.status = wire;
    return this;
  }

  startChildSpan(operation: string, description?: string | null): SpanObject {
    this.guard();
    const op = assertText(operation, 'startChildSpan', 'operation');
    const body = optionalDescription(description);
    const child = adopt(NativeBugsee.spanStartChild(this.wire.handle, op, body));
    if (child === null) {
      dead();
    }
    return child;
  }

  /**
   * Finishes the span. No argument is the SDK's no-arg `finish` (status OK).
   * The native handle is released, including any child this finish ended.
   */
  finish(status?: SpanStatus): void {
    this.guard();
    const explicit = status !== undefined;
    const wire = explicit ? assertStatus(status) : 0;
    const released = NativeBugsee.spanFinish(this.wire.handle, wire, explicit);
    markReleased(released);
    if (!this.dead) {
      this.markDead();
      live.delete(this.wire.handle);
      dead();
    }
  }

  get operationName(): string {
    return this.operation;
  }

  get descriptionText(): string | null {
    return this.description;
  }

  get statusValue(): number {
    return this.status;
  }

  get isFinished(): boolean {
    return this.finishedFlag;
  }

  get attributeMap(): Readonly<Record<string, SpanAttribute>> {
    return this.attributes;
  }

  markDead(): void {
    this.dead = true;
    this.finishedFlag = true;
  }

  private guard(): void {
    if (this.dead) {
      dead();
    }
  }
}

function parseAttributes(json: string): Record<string, SpanAttribute> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return Object.create(null);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.create(null);
  }
  const result: Record<string, SpanAttribute> = Object.create(null);
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      result[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value;
    }
  }
  return result;
}

function optionalDescription(description: string | null | undefined): string | null {
  if (description === undefined || description === null) {
    return null;
  }
  if (typeof description !== 'string') {
    throw new TypeError('Bugsee span description must be a string or null');
  }
  return description;
}

export interface BugseeSpan {
  readonly spanId: string;
  readonly traceId: string;
  readonly operation: string;
  readonly description: string | null;
  readonly status: SpanStatus;
  readonly finished: boolean;
  readonly attributes: Readonly<Record<string, SpanAttribute>>;
  setName(name: string): this;
  setDescription(description: string | null): this;
  setAttribute(key: string, value: SpanAttribute): this;
  setStatus(status: SpanStatus): this;
  startChildSpan(operation: string, description?: string | null): BugseeSpan;
  finish(status?: SpanStatus): void;
}

export interface BugseeTransaction extends BugseeSpan {
  readonly name: string;
  readonly sampled: boolean;
}

class PublicSpan implements BugseeSpan {
  constructor(private readonly inner: SpanObject) {}

  get spanId(): string {
    return this.inner.spanId;
  }
  get traceId(): string {
    return this.inner.traceId;
  }
  get operation(): string {
    return this.inner.operationName;
  }
  get description(): string | null {
    return this.inner.descriptionText;
  }
  get status(): SpanStatus {
    return this.inner.statusValue as SpanStatus;
  }
  get finished(): boolean {
    return this.inner.isFinished;
  }
  get attributes(): Readonly<Record<string, SpanAttribute>> {
    return this.inner.attributeMap;
  }
  setName(name: string): this {
    this.inner.setName(name);
    return this;
  }
  setDescription(description: string | null): this {
    this.inner.setDescription(description);
    return this;
  }
  setAttribute(key: string, value: SpanAttribute): this {
    this.inner.setAttribute(key, value);
    return this;
  }
  setStatus(status: SpanStatus): this {
    this.inner.setStatus(status);
    return this;
  }
  startChildSpan(operation: string, description?: string | null): BugseeSpan {
    return wrap(this.inner.startChildSpan(operation, description));
  }
  finish(status?: SpanStatus): void {
    this.inner.finish(status);
  }
}

class PublicTransaction extends PublicSpan implements BugseeTransaction {
  readonly name: string;
  readonly sampled: boolean;

  constructor(inner: SpanObject, name: string, sampled: boolean) {
    super(inner);
    this.name = name;
    this.sampled = sampled;
  }
}

const wrapped = new WeakMap<SpanObject, BugseeSpan>();

function wrap(inner: SpanObject): BugseeSpan {
  const existing = wrapped.get(inner);
  if (existing !== undefined) {
    return existing;
  }
  const name = innerWireName(inner);
  const span =
    name === undefined
      ? new PublicSpan(inner)
      : new PublicTransaction(inner, name.name, name.sampled);
  wrapped.set(inner, span);
  return span;
}

function innerWireName(inner: SpanObject): { name: string; sampled: boolean } | undefined {
  if (inner.transactionName === undefined) {
    return undefined;
  }
  return { name: inner.transactionName, sampled: inner.transactionSampled };
}

export function startTransaction(
  name: string,
  operation: string,
  attributes?: Readonly<Record<string, SpanAttribute>>,
): BugseeTransaction {
  const txnName = assertText(name, 'startTransaction', 'name');
  const op = assertText(operation, 'startTransaction', 'operation');
  const attrs = assertAttributes(attributes);
  const span = adopt(
    NativeBugsee.startTransaction(
      txnName,
      op,
      attrs === null ? null : encodeBridgeObject(attrs),
    ),
  );
  if (span === null || !('name' in wrap(span))) {
    throw new Error('Bugsee.startTransaction did not return a transaction');
  }
  return wrap(span) as BugseeTransaction;
}

export function startSpan(operation: string, description?: string | null): BugseeSpan {
  const op = assertText(operation, 'startSpan', 'operation');
  const span = adopt(NativeBugsee.startSpan(op, optionalDescription(description)));
  if (span === null) {
    throw new Error('Bugsee.startSpan did not return a span');
  }
  return wrap(span);
}

export function getActiveSpan(): BugseeSpan | null {
  const span = adopt(NativeBugsee.getActiveSpan());
  return span === null ? null : wrap(span);
}
