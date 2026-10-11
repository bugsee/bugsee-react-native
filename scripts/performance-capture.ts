/**
 * Reads a report's `performance` capture as transactions, whichever layout
 * the SDK wrote (bugsee/specs `sdk/reporting/bundle/performance.md`):
 *
 * - legacy, `{"transactions": [...]}`: iOS 7.0.0-beta5 and Android up to
 *   7.3.0. Returned as is.
 * - OTLP/JSON, `{"resourceSpans": [...]}`: Android 7.3.1 (bugsee-android
 *   #207). Read by the spec's "OTLP reader (profile 2)" rules: every
 *   resourceSpans and scopeSpans, local roots by the local-root rule,
 *   deduplicated on (traceId, spanId) keeping the copy without
 *   `bugsee.snapshot`, and each span's detail from the first present of
 *   `url.full`, `db.query.text`, `file.path`, `bugsee.description`.
 *
 * Each root becomes one transaction in the legacy shape the e2e asserts on:
 * `name` is the root's name, `operation` and `status` its `bugsee.operation`
 * and `bugsee.span.status`, and `spans` holds the root itself first (no
 * `parentSpanId`, as Android's legacy layout repeated it) followed by the
 * rest of its trace. `attributes` is a flat key -> value object.
 */

export interface CaptureSpan {
  spanId?: string;
  parentSpanId?: string;
  operation?: string;
  description?: string;
  status?: string;
  attributes?: Record<string, unknown>;
}

export interface CaptureTransaction {
  name?: string;
  operation?: string;
  status?: string;
  spans?: CaptureSpan[];
}

interface OtlpValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: OtlpValue[] };
  kvlistValue?: { values?: OtlpAttribute[] };
}
interface OtlpAttribute {
  key: string;
  value?: OtlpValue;
}
interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  flags?: number;
  name?: string;
  attributes?: OtlpAttribute[];
}

/** `SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK`: the parent is in another process. */
const REMOTE_PARENT = 0x200;
const DETAIL_KEYS = ['url.full', 'db.query.text', 'file.path', 'bugsee.description'] as const;

export function otlpValue(value: OtlpValue | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value.stringValue !== undefined) {
    return value.stringValue;
  }
  if (value.boolValue !== undefined) {
    return value.boolValue;
  }
  if (value.intValue !== undefined) {
    return Number(value.intValue);
  }
  if (value.doubleValue !== undefined) {
    return value.doubleValue;
  }
  if (value.arrayValue !== undefined) {
    return (value.arrayValue.values ?? []).map(otlpValue);
  }
  if (value.kvlistValue !== undefined) {
    return flatten(value.kvlistValue.values);
  }
  return undefined;
}

function flatten(attributes: readonly OtlpAttribute[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const attribute of attributes ?? []) {
    out[attribute.key] = otlpValue(attribute.value);
  }
  return out;
}

const lower = (id: string | undefined): string | undefined => (id === undefined || id === '' ? undefined : id.toLowerCase());

function isLocalRoot(span: OtlpSpan): boolean {
  return lower(span.parentSpanId) === undefined || ((span.flags ?? 0) & REMOTE_PARENT) !== 0;
}

function toSpan(span: OtlpSpan, root: boolean): CaptureSpan {
  const attributes = flatten(span.attributes);
  const detail = DETAIL_KEYS.map(key => attributes[key]).find(value => value !== undefined);
  const out: CaptureSpan = {
    spanId: lower(span.spanId),
    operation: attributes['bugsee.operation'] as string | undefined,
    status: attributes['bugsee.span.status'] as string | undefined,
    attributes,
  };
  if (!root) {
    out.parentSpanId = lower(span.parentSpanId);
  }
  if (detail !== undefined) {
    out.description = String(detail);
  }
  return out;
}

/** The OTLP spans of a capture, every resource and scope, deduplicated on (traceId, spanId). */
function otlpSpans(document: { resourceSpans?: unknown }): OtlpSpan[] {
  const byId = new Map<string, OtlpSpan>();
  const resources = Array.isArray(document.resourceSpans) ? document.resourceSpans : [];
  for (const resource of resources as Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>) {
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const key = `${lower(span.traceId)}/${lower(span.spanId)}`;
        const kept = byId.get(key);
        if (kept === undefined || (snapshot(kept) && !snapshot(span))) {
          byId.set(key, span);
        }
      }
    }
  }
  return [...byId.values()];
}

const snapshot = (span: OtlpSpan): boolean => flatten(span.attributes)['bugsee.snapshot'] === true;

/** The transactions in a `performance` capture's text, either layout. */
export function performanceTransactions(text: string): CaptureTransaction[] {
  const document = JSON.parse(text) as { transactions?: CaptureTransaction[]; resourceSpans?: unknown };
  if (document.resourceSpans === undefined) {
    return document.transactions ?? [];
  }
  const spans = otlpSpans(document);
  return spans.filter(isLocalRoot).map(root => {
    const trace = lower(root.traceId);
    const rootSpan = toSpan(root, true);
    // A root's trace: its descendants in this file, by parent links.
    const members: CaptureSpan[] = [rootSpan];
    const ids = new Set([rootSpan.spanId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const span of spans) {
        if (lower(span.traceId) !== trace || ids.has(lower(span.spanId)) || isLocalRoot(span)) {
          continue;
        }
        if (ids.has(lower(span.parentSpanId))) {
          ids.add(lower(span.spanId));
          members.push(toSpan(span, false));
          grew = true;
        }
      }
    }
    return {
      name: root.name,
      operation: rootSpan.operation,
      status: rootSpan.status,
      spans: members,
    };
  });
}
