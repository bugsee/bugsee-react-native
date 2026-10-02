/**
 * The breadcrumb-filter scenario Task 9.5 drives on a device
 * (e2e/breadcrumb-filter.test.ts).
 *
 * After `Launched` it installs `Bugsee.setBreadcrumbFilter` and then calls
 * `Bugsee.addBreadcrumb` on the next line, with no await between them. That
 * first crumb is rewritten. A second crumb is rewritten the same way. A third
 * crumb's callback never settles, so it is not recorded; this scenario does
 * not add a timeout that would pass the crumb through. A fourth crumb carries
 * a secret and `setBreadcrumbFilter(null)` is the next call, on that same
 * turn. The secret is redacted. The clear is not awaited.
 *
 * A crumb that is not one of the probes is returned unchanged, so the SDK's
 * own breadcrumb capture still records. The upload waits long enough for the
 * rewrite's round trip to be recorded. The recording `duration` stays the
 * app's 90. Breadcrumb capture is turned on for this scenario only: it stays
 * off on Android and on iOS until launch options set `captureBreadcrumbs`.
 */
import Bugsee from '@bugsee/react-native';

export const BREADCRUMB_FILTER_SCENARIOS = ['breadcrumb-filter'] as const;

export type BreadcrumbFilterScenario = (typeof BREADCRUMB_FILTER_SCENARIOS)[number];

export function isBreadcrumbFilterScenario(name: string): name is BreadcrumbFilterScenario {
  return (BREADCRUMB_FILTER_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E breadcrumb-filter ${message}`);
}

/** How long to wait, after the crumbs are sent, before uploading. */
const UPLOAD_AFTER_MS = 5_000;

function probe(
  kind: 'immediate' | 'rewrite' | 'hang' | 'cleared',
  nonce: string,
): string {
  return `breadcrumb-filter ${kind} ${nonce}`;
}

/**
 * A crumb that is not one of the probes is returned unchanged, so the SDK's
 * own breadcrumb capture still records.
 */
export function installBreadcrumbFilter(nonce: string): void {
  Bugsee.setBreadcrumbFilter((crumb) => {
    const message = crumb.message ?? '';
    if (
      message.includes(probe('immediate', nonce)) ||
      message.includes(probe('rewrite', nonce)) ||
      message.includes(probe('cleared', nonce))
    ) {
      return { ...crumb, message: message.replace('SECRET', 'REDACTED') };
    }
    if (message.includes(probe('hang', nonce))) {
      return new Promise(() => {});
    }
    return crumb;
  });
}

function record(kind: 'immediate' | 'rewrite' | 'hang' | 'cleared', nonce: string): void {
  Bugsee.addBreadcrumb({
    category: 'e2e',
    level: 'info',
    message: `${probe(kind, nonce)} SECRET`,
    type: 'user',
  });
}

/**
 * Called once the SDK reaches `Launched`. `setBreadcrumbFilter` and the first
 * `addBreadcrumb` are adjacent: nothing is awaited between them, so the
 * native registration has to have finished before `setBreadcrumbFilter` returns.
 */
export function runBreadcrumbFilterScenario(nonce: string): void {
  installBreadcrumbFilter(nonce);
  record('immediate', nonce);
  mark(`filter installed nonce=${nonce}`);
  mark(`immediate sent nonce=${nonce}`);
  record('rewrite', nonce);
  mark(`rewrite sent nonce=${nonce}`);
  record('hang', nonce);
  mark(`hang sent nonce=${nonce}`);
  // Same turn as the add above: nothing is awaited between them. The clear
  // must not overtake that crumb, and the secret must be redacted.
  record('cleared', nonce);
  Bugsee.setBreadcrumbFilter(null);
  mark(`cleared same turn nonce=${nonce}`);
  setTimeout(() => {
    Bugsee.upload(`breadcrumb-filter-${nonce}`, '');
    mark(`uploaded nonce=${nonce}`);
  }, UPLOAD_AFTER_MS);
}
