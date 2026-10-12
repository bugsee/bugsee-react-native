import Bugsee from '@bugsee/react-native';
import { ActionButton } from '../ui/ActionButton';
import type { Action } from '../ui/action';
import { Screen } from '../ui/Screen';
import { Section } from '../ui/Section';

const REJECT = 'Rejects with BugseeAttributeError, code E_ATTRIBUTE_BAD_ARGUMENT (shown in the log)';

export const dataActions: Action[] = [
  { id: 'user-set', label: 'Set user identifier', call: "Bugsee.setUserIdentifier('playground-user@example.com')", expect: "The report's user is playground-user@example.com until cleared", run: () => Bugsee.setUserIdentifier('playground-user@example.com') },
  { id: 'user-get', label: 'Get user identifier', call: 'Bugsee.getUserIdentifier()', expect: 'playground-user@example.com after set; undefined after clear', run: () => Bugsee.getUserIdentifier() },
  { id: 'user-clear', label: 'Clear user identifier', call: 'Bugsee.clearUserIdentifier()', expect: 'The report has no user', run: () => Bugsee.clearUserIdentifier() },

  { id: 'attr-string', label: 'Set string attribute', call: "Bugsee.setAttribute('plan', 'pro')", expect: "Attribute plan = pro in the report's attributes", run: () => Bugsee.setAttribute('plan', 'pro') },
  { id: 'attr-int', label: 'Set integer attribute', call: "Bugsee.setAttribute('seats', 5)", expect: 'Attribute seats = 5', run: () => Bugsee.setAttribute('seats', 5) },
  { id: 'attr-double', label: 'Set decimal attribute', call: "Bugsee.setAttribute('ratio', 0.75)", expect: 'Attribute ratio = 0.75', run: () => Bugsee.setAttribute('ratio', 0.75) },
  { id: 'attr-bool', label: 'Set boolean attribute', call: "Bugsee.setAttribute('beta', true)", expect: 'Attribute beta = true', run: () => Bugsee.setAttribute('beta', true) },
  { id: 'attr-get', label: 'Get attribute', call: "Bugsee.getAttribute('plan')", expect: "'pro' after set; undefined after clear", run: () => Bugsee.getAttribute('plan') },
  { id: 'attr-get-all', label: 'Get all attributes', call: 'Bugsee.getAllAttributes()', expect: 'An object with every attribute set so far', run: () => Bugsee.getAllAttributes() },
  { id: 'attr-clear', label: 'Clear attribute', call: "Bugsee.clearAttribute('plan')", expect: 'plan is gone from getAllAttributes', run: () => Bugsee.clearAttribute('plan') },
  { id: 'attr-clear-all', label: 'Clear all attributes', call: 'Bugsee.clearAllAttributes()', expect: 'getAllAttributes returns {}', run: () => Bugsee.clearAllAttributes() },
  { id: 'attr-bad-name', label: 'Set attribute with empty name', call: "Bugsee.setAttribute('', 'x')", expect: REJECT, run: () => Bugsee.setAttribute('', 'x') },
  { id: 'attr-bad-object', label: 'Set object attribute', call: "Bugsee.setAttribute('obj', { a: 1 } as never)", expect: REJECT, run: () => Bugsee.setAttribute('obj', { a: 1 } as never) },
  { id: 'attr-bad-nan', label: 'Set NaN attribute', call: "Bugsee.setAttribute('nan', Number.NaN)", expect: REJECT, run: () => Bugsee.setAttribute('nan', Number.NaN) },

  { id: 'crumb-basic', label: 'Add breadcrumb', call: "Bugsee.addBreadcrumb({ category: 'ui', level: 'info', message: 'Tapped Add breadcrumb', type: 'user' })", expect: "A ui breadcrumb 'Tapped Add breadcrumb' in the report's breadcrumbs", run: () => Bugsee.addBreadcrumb({ category: 'ui', level: 'info', message: 'Tapped Add breadcrumb', type: 'user' }) },
  { id: 'crumb-data', label: 'Add breadcrumb with data', call: "Bugsee.addBreadcrumb({ category: 'ui', level: 'info', message: 'Tapped with data', type: 'user', data: { screen: 'Data' } })", expect: 'A breadcrumb carrying screen = Data', run: () => Bugsee.addBreadcrumb({ category: 'ui', level: 'info', message: 'Tapped with data', type: 'user', data: { screen: 'Data' } }) },
  { id: 'crumb-filter', label: 'Drop ui breadcrumbs', call: "Bugsee.setBreadcrumbFilter((c) => (c.category === 'ui' ? null : c))", expect: 'ui breadcrumbs are dropped', run: () => Bugsee.setBreadcrumbFilter((c) => (c.category === 'ui' ? null : c)) },
  { id: 'crumb-filter-clear', label: 'Remove breadcrumb filter', call: 'Bugsee.setBreadcrumbFilter(null)', expect: 'ui breadcrumbs are recorded again', run: () => Bugsee.setBreadcrumbFilter(null) },

  { id: 'event-plain', label: 'Event without params', call: "Bugsee.event('playground_event')", expect: "Event playground_event in the report's timeline", run: () => Bugsee.event('playground_event') },
  { id: 'event-params', label: 'Event with params', call: "Bugsee.event('purchase', { sku: 'A-1', qty: 2, gift: false })", expect: "Event purchase with sku, qty and gift in the report's timeline", run: () => Bugsee.event('purchase', { sku: 'A-1', qty: 2, gift: false }) },
  { id: 'trace-number', label: 'Trace number', call: "Bugsee.trace('cart_total', 42.5)", expect: "Trace cart_total = 42.5 in the report's timeline", run: () => Bugsee.trace('cart_total', 42.5) },
  { id: 'trace-bool', label: 'Trace boolean', call: "Bugsee.trace('signed_in', true)", expect: "Trace signed_in = true in the report's timeline", run: () => Bugsee.trace('signed_in', true) },
  { id: 'trace-string', label: 'Trace string', call: "Bugsee.trace('tier', 'gold')", expect: "Trace tier = gold in the report's timeline", run: () => Bugsee.trace('tier', 'gold') },
];

const byPrefix = (p: string) => dataActions.filter((a) => a.id.startsWith(p));

export default function DataScreen() {
  const section = (title: string, prefix: string) => (
    <Section title={title}>{byPrefix(prefix).map((a) => <ActionButton key={a.id} action={a} />)}</Section>
  );
  return (
    <Screen title="Data">
      {section('User', 'user-')}
      {section('Attributes', 'attr-')}
      {section('Breadcrumbs', 'crumb-')}
      <Section title="Events and traces">{[...byPrefix('event-'), ...byPrefix('trace-')].map((a) => <ActionButton key={a.id} action={a} />)}</Section>
    </Screen>
  );
}
