import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import Bugsee, { SpanStatus } from '@bugsee/react-native';
import type { BugseeSpan } from '@bugsee/react-native';
import { fetchProducts } from '../demoApi';
import { runFakeCheckout } from '../fakeCheckout';
import { ActionButton } from '../ui/ActionButton';
import type { Action } from '../ui/action';
import { Screen } from '../ui/Screen';
import { Section } from '../ui/Section';

// Slow render: the action stores the open span and notifies the screen, which renders 3000 rows
// and finishes the span in an effect after commit.
let pendingRender: BugseeSpan | null = null;
let onSlowRender: ((span: BugseeSpan) => void) | null = null;

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
    id: 'rename-status',
    label: 'Rename and set status',
    call: "Bugsee.startTransaction('rename-me', 'ui.action')",
    expect: "A transaction named 'renamed' with status Error",
    run: () => {
      const tx = Bugsee.startTransaction('rename-me', 'ui.action');
      tx.setName('renamed');
      tx.setStatus(SpanStatus.Error);
      tx.finish();
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
    call: "Bugsee.startSpan('ui.render', 'slow list')",
    expect: 'A ui.render span covering the 3000-row render',
    run: () => {
      const span = Bugsee.startSpan('ui.render', 'slow list');
      if (onSlowRender) onSlowRender(span);
      else pendingRender = span;
    },
  },
];

function SlowList({ span }: { span: BugseeSpan }) {
  useEffect(() => {
    span.finish(SpanStatus.OK);
  }, [span]);
  return (
    <>
      {Array.from({ length: 3000 }, (_, i) => (
        <Text key={i}>Row {i}</Text>
      ))}
    </>
  );
}

export default function PerfScreen() {
  const [run, setRun] = useState<{ n: number; span: BugseeSpan } | null>(null);
  const show = (span: BugseeSpan) => setRun((r) => ({ n: (r?.n ?? 0) + 1, span }));
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
          <SlowList key={run.n} span={run.span} />
        </Section>
      )}
    </Screen>
  );
}
