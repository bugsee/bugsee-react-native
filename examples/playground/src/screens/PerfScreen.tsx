import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import Bugsee, { SpanStatus } from '@bugsee/react-native';
import type { BugseeSpan, BugseeTransaction } from '@bugsee/react-native';
import { fetchProducts } from '../demoApi';
import { runFakeCheckout } from '../fakeCheckout';
import { ActionButton } from '../ui/ActionButton';
import type { Action } from '../ui/action';
import { Screen } from '../ui/Screen';
import { Section } from '../ui/Section';

// Slow render: the action opens a transaction and a ui.render child span (a span with no active transaction is
// a no-op), then notifies the screen, which renders 3000 rows and finishes both in an effect after commit.
type SlowRender = { tx: BugseeTransaction; span: BugseeSpan };
let pendingRender: SlowRender | null = null;
let onSlowRender: ((r: SlowRender) => void) | null = null;

export const perfActions: Action[] = [
  {
    id: 'fake-checkout',
    label: 'Fake checkout transaction',
    call: "Bugsee.startTransaction('checkout', 'ui.action', { cart_items: 3 })",
    expect: 'A checkout transaction of about 1.2 s with 3 child spans in Performance',
    run: () => runFakeCheckout(),
  },
  {
    id: 'span-no-transaction',
    label: 'Span without a transaction',
    call: "Bugsee.startSpan('manual.work', 'no transaction')",
    expect: 'A no-op without an active transaction',
    run: () => {
      Bugsee.startSpan('manual.work', 'no transaction').finish();
    },
  },
  {
    id: 'active-span',
    label: 'Get active span',
    call: 'Bugsee.getActiveSpan()',
    expect: 'null outside a transaction',
    run: () => Bugsee.getActiveSpan(),
  },
  {
    id: 'active-span-in-transaction',
    label: 'Get active span inside a transaction',
    call: "Bugsee.getActiveSpan() inside Bugsee.startTransaction('active-span', 'ui.action')",
    expect: "returns the transaction's span",
    run: () => {
      const tx = Bugsee.startTransaction('active-span', 'ui.action');
      try {
        return Bugsee.getActiveSpan();
      } finally {
        tx.finish();
      }
    },
  },
  {
    id: 'rename-status',
    label: 'Rename and set status',
    call: "Bugsee.startTransaction('rename-me', 'ui.action')",
    expect:
      "Transaction 'rename-me' whose operation is now 'renamed', ending with status Error (setName sets the operation; pass the status to finish(), a bare finish() ends OK)",
    run: () => {
      const tx = Bugsee.startTransaction('rename-me', 'ui.action');
      tx.setName('renamed');
      tx.setStatus(SpanStatus.Error);
      tx.finish(SpanStatus.Error);
    },
  },
  {
    id: 'nested-network',
    label: 'Nested spans around network',
    call: "Bugsee.startTransaction('load-products', 'ui.load')",
    expect: 'A load-products transaction with an http.client span around the request and a parse span',
    run: async () => {
      const tx = Bugsee.startTransaction('load-products', 'ui.load');
      const http = tx.startChildSpan('http.client', 'fetchProducts');
      const result = await fetchProducts();
      http.finish(SpanStatus.OK);
      const parse = tx.startChildSpan('parse', `${result.products.length} products`);
      parse.finish(SpanStatus.OK);
      tx.finish(SpanStatus.OK);
      return result.source;
    },
  },
  {
    id: 'slow-render',
    label: 'Slow render (3000 rows)',
    call: "Bugsee.startTransaction('slow-render', 'ui.render') with a child span 'slow list'",
    expect: 'A slow-render transaction whose ui.render child span covers the 3000-row render',
    run: () => {
      const tx = Bugsee.startTransaction('slow-render', 'ui.render');
      const r = { tx, span: tx.startChildSpan('ui.render', 'slow list') };
      if (onSlowRender) onSlowRender(r);
      else pendingRender = r;
    },
  },
];

function SlowList({ render: { tx, span } }: { render: SlowRender }) {
  useEffect(() => {
    span.finish(SpanStatus.OK);
    tx.finish(SpanStatus.OK);
  }, [tx, span]);
  return (
    <>
      {Array.from({ length: 3000 }, (_, i) => (
        <Text key={i}>Row {i}</Text>
      ))}
    </>
  );
}

export default function PerfScreen() {
  const [run, setRun] = useState<{ n: number; render: SlowRender } | null>(null);
  const show = (render: SlowRender) => setRun((r) => ({ n: (r?.n ?? 0) + 1, render }));
  useEffect(() => {
    onSlowRender = show;
    if (pendingRender) {
      show(pendingRender);
      pendingRender = null;
    }
    return () => {
      onSlowRender = null;
    };
  }, []);
  return (
    <Screen title="Perf">
      <Section title="Transactions and spans">
        {perfActions.map((a) => (
          <ActionButton key={a.id} action={a} />
        ))}
      </Section>
      {run && (
        <Section title="Slow list">
          <SlowList key={run.n} render={run.render} />
        </Section>
      )}
    </Screen>
  );
}
