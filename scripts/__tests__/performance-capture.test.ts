import { otlpValue, performanceTransactions } from '../performance-capture';

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });

interface Fields {
  spanId: string;
  name: string;
  parentSpanId?: string;
  traceId?: string;
  flags?: number;
}

function span(fields: Fields, attributes: Array<{ key: string; value: unknown }>) {
  return { traceId: 'AB'.repeat(16), flags: 256, kind: 1, ...fields, attributes };
}

const ROOT = span({ spanId: '1111111111111111', name: 'txn-start' }, [
  str('bugsee.operation', 'txn-renamed'),
  str('bugsee.span.status', 'ERROR'),
  str('bugsee.description', 'txn-desc'),
]);
const CHILD = span({ spanId: '2222222222222222', parentSpanId: '1111111111111111', name: 'cov.child' }, [
  str('bugsee.operation', 'cov.child'),
  str('bugsee.span.status', 'CANCELLED'),
  str('bugsee.description', 'child-desc'),
  { key: 'n', value: { intValue: '42' } },
]);
const GRANDCHILD = span({ spanId: '3333333333333333', parentSpanId: '2222222222222222', name: 'GET' }, [
  str('bugsee.operation', 'http.client'),
  str('bugsee.span.status', 'OK'),
  str('url.full', 'https://127.0.0.1:9/x'),
  str('bugsee.description', 'not this'),
]);
const OTHER_ROOT = span({ traceId: 'cd'.repeat(16), spanId: '4444444444444444', name: 'other' }, [str('bugsee.operation', 'other.op')]);

const otlp = (spans: unknown[], extra: unknown[] = []) =>
  JSON.stringify({
    resourceSpans: [
      { resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'com.bugsee.android' }, spans }] },
      ...extra,
    ],
  });

describe('performanceTransactions', () => {
  it('returns a legacy capture as is', () => {
    const legacy = { transactions: [{ name: 't', operation: 'op', spans: [{ spanId: 'a', description: 'd' }] }] };
    expect(performanceTransactions(JSON.stringify(legacy))).toEqual(legacy.transactions);
    expect(performanceTransactions('{}')).toEqual([]);
  });

  it('reads an OTLP capture as one transaction per local root, root first', () => {
    const [txn, other, ...rest] = performanceTransactions(otlp([ROOT, CHILD, GRANDCHILD, OTHER_ROOT]));
    expect(rest).toEqual([]);
    expect(txn).toEqual({
      name: 'txn-start',
      operation: 'txn-renamed',
      status: 'ERROR',
      spans: [
        {
          spanId: '1111111111111111',
          operation: 'txn-renamed',
          status: 'ERROR',
          description: 'txn-desc',
          attributes: { 'bugsee.operation': 'txn-renamed', 'bugsee.span.status': 'ERROR', 'bugsee.description': 'txn-desc' },
        },
        {
          spanId: '2222222222222222',
          parentSpanId: '1111111111111111',
          operation: 'cov.child',
          status: 'CANCELLED',
          description: 'child-desc',
          attributes: { 'bugsee.operation': 'cov.child', 'bugsee.span.status': 'CANCELLED', 'bugsee.description': 'child-desc', n: 42 },
        },
        {
          spanId: '3333333333333333',
          parentSpanId: '2222222222222222',
          operation: 'http.client',
          status: 'OK',
          // url.full comes before bugsee.description.
          description: 'https://127.0.0.1:9/x',
          attributes: expect.any(Object),
        },
      ],
    });
    expect(other).toEqual({
      name: 'other',
      operation: 'other.op',
      status: undefined,
      spans: [{ spanId: '4444444444444444', operation: 'other.op', status: undefined, attributes: { 'bugsee.operation': 'other.op' } }],
    });
  });

  it('finds children in any order, across resources, with ids in any case', () => {
    const upper = { ...CHILD, spanId: CHILD.spanId, parentSpanId: '1111111111111111'.toUpperCase(), traceId: 'ab'.repeat(16) };
    const [txn] = performanceTransactions(
      otlp([GRANDCHILD], [{ scopeSpans: [{ spans: [upper] }, { spans: [ROOT] }] }]),
    );
    expect(txn!.spans!.map(s => s.spanId)).toEqual(['1111111111111111', '2222222222222222', '3333333333333333']);
  });

  it('takes a continued root (remote parent flag) as a root, and a span of another trace as not a child', () => {
    const continued = span({ spanId: '5555555555555555', parentSpanId: '9999999999999999', flags: 256 | 0x200, name: 'continued' }, []);
    const stranger = span({ traceId: 'ef'.repeat(16), spanId: '6666666666666666', parentSpanId: '1111111111111111', name: 's' }, []);
    const names = performanceTransactions(otlp([ROOT, continued, stranger])).map(t => [t.name, t.spans!.length]);
    expect(names).toEqual([['txn-start', 1], ['continued', 1]]);
  });

  it('keeps the completed copy of a span written twice, whichever comes first', () => {
    const snap = { ...CHILD, attributes: [...CHILD.attributes, { key: 'bugsee.snapshot', value: { boolValue: true } }, str('bugsee.description', 'snap')] };
    for (const order of [[ROOT, snap, CHILD], [ROOT, CHILD, snap]]) {
      const [txn] = performanceTransactions(otlp(order));
      expect(txn!.spans!.map(s => s.description)).toEqual(['txn-desc', 'child-desc']);
    }
  });

  it('reads every OTLP value kind', () => {
    expect(otlpValue(undefined)).toBeUndefined();
    expect(otlpValue({})).toBeUndefined();
    expect(otlpValue({ stringValue: '' })).toBe('');
    expect(otlpValue({ boolValue: false })).toBe(false);
    expect(otlpValue({ intValue: '0' })).toBe(0);
    expect(otlpValue({ intValue: 7 })).toBe(7);
    expect(otlpValue({ doubleValue: 0 })).toBe(0);
    expect(otlpValue({ arrayValue: { values: [{ stringValue: 'a' }, { intValue: '2' }] } })).toEqual(['a', 2]);
    expect(otlpValue({ arrayValue: {} })).toEqual([]);
    expect(otlpValue({ kvlistValue: { values: [{ key: 'k', value: { boolValue: true } }] } })).toEqual({ k: true });
    expect(otlpValue({ kvlistValue: {} })).toEqual({});
  });

  it('treats an empty parentSpanId as no parent', () => {
    const [txn] = performanceTransactions(otlp([{ ...ROOT, parentSpanId: '' }]));
    expect(txn!.name).toBe('txn-start');
  });
});
