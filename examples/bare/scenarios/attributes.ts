/**
 * The attribute and identity scenarios Task 5.4 drives on a device
 * (e2e/attributes.test.ts).
 *
 * `attributes` clears every attribute and the identifier, logs that the
 * slate is clean (the precondition: identity persists across runs, so a
 * stale value would otherwise pass), sets one attribute per row of the
 * design doc's Phase 5 table, reads each back, clears one, reads them all,
 * walks the identifier through set / `''` / set, and uploads -- so the test
 * can compare what JS read with what the retained report carries.
 *
 * `attributes-persist` is the next run, in a fresh process: it logs what
 * survived the restart, clears everything, and logs that the clear took. It
 * is also what the e2e runs to leave the handset clean.
 *
 * Every result is one line, `BUGSEE_E2E attr <label> <json>`, awaited in
 * order. A read is logged as `{"type": typeof v, "value": v}`, with no
 * `value` member when `v` is undefined. Values are synthetic: until
 * bugsee-android#186 ships, the Android SDK writes them to its internal log.
 */
import Bugsee, { type AttributeValue } from '@bugsee/react-native';

export const ATTRIBUTE_SCENARIOS = ['attributes', 'attributes-persist'] as const;

export type AttributeScenario = (typeof ATTRIBUTE_SCENARIOS)[number];

export function isAttributeScenario(name: string): name is AttributeScenario {
  return (ATTRIBUTE_SCENARIOS as readonly string[]).includes(name);
}

/**
 * The rows the scenario sets, in order. The e2e holds its own copy with the
 * expected outcomes (e2e/attributes.test.ts): an e2e that imported the app's
 * values could not notice the app sending the wrong ones.
 */
export function attributeRows(nonce: string): Array<[string, AttributeValue]> {
  return [
    ['e2e_str', `blue-${nonce}`],
    ['e2e_empty', ''],
    ['e2e_int', 42],
    ['e2e_neg', -7],
    ['e2e_int64', 2147483648],
    ['e2e_safe', 9007199254740991],
    ['e2e_half', 1.5],
    ['e2e_tenth', 0.1],
    ['e2e_true', true],
    ['e2e_false', false],
    ['e2e_mid', 'm'.repeat(800)],
    ['e2e_900', 'n'.repeat(900)],
    ['e2e_long', 'x'.repeat(1024)],
    ['e2e_too_long', 'x'.repeat(1025)],
    ['e2e_huge', 3.5e38],
    ['e2e_over_long', 1e19],
  ];
}

function mark(label: string, value: unknown): void {
  console.log(`BUGSEE_E2E attr ${label} ${JSON.stringify(value)}`);
}

function read(value: unknown): { type: string; value?: unknown } {
  return value === undefined ? { type: 'undefined' } : { type: typeof value, value };
}

async function logAll(label: string): Promise<void> {
  mark(label, await Bugsee.getAllAttributes());
}

async function logIdentifier(label: string): Promise<void> {
  mark(label, read(await Bugsee.getUserIdentifier()));
}

async function runAttributes(nonce: string): Promise<void> {
  // 1. The precondition.
  await Bugsee.clearAllAttributes();
  Bugsee.clearUserIdentifier();
  await logAll('pre-all');
  await logIdentifier('pre-id');

  // 2. Every row: the set's outcome, then the read-back.
  for (const [name, value] of attributeRows(nonce)) {
    try {
      await Bugsee.setAttribute(name, value);
      mark(`set:${name}`, { result: 'resolved' });
    } catch (error) {
      mark(`set:${name}`, {
        result: 'rejected',
        code: (error as { code?: unknown }).code ?? null,
        message: String((error as { message?: unknown }).message),
      });
    }
    mark(`get:${name}`, read(await Bugsee.getAttribute(name)));
  }

  // 3. One cleared.
  await Bugsee.clearAttribute('e2e_neg');
  mark('cleared:e2e_neg', read(await Bugsee.getAttribute('e2e_neg')));

  // 4. Everything, as the report should carry it.
  await logAll('all');

  // 5. Identity: set, empty (clears), set again.
  Bugsee.setUserIdentifier(`e2e-user-${nonce}`);
  await logIdentifier('id-set');
  Bugsee.setUserIdentifier('');
  await logIdentifier('id-empty');
  Bugsee.setUserIdentifier(`e2e-user-${nonce}`);
  await logIdentifier('id-final');

  // 6. The report.
  mark('uploading', { nonce });
  Bugsee.upload(`attrs-${nonce}`, '');
}

async function runAttributesPersist(): Promise<void> {
  await logAll('persist-all');
  await logIdentifier('persist-id');
  await Bugsee.clearAllAttributes();
  Bugsee.clearUserIdentifier();
  await logAll('cleared-all');
  await logIdentifier('cleared-id');
}

/** Called once the SDK reaches `Launched`. */
export function runAttributeScenario(scenario: AttributeScenario, nonce: string): void {
  const body = scenario === 'attributes' ? runAttributes(nonce) : runAttributesPersist();
  body
    .then(() => mark('done', { scenario, nonce }))
    .catch(error => mark('failed', { scenario, nonce, error: String(error) }));
}
