/**
 * The JS-fetch scenario Task 9.3 drives on a device (e2e/network.test.ts).
 *
 * After `Launched`, one `fetch` to a closed loopback URL that carries the
 * run's nonce. The URL does not need to answer: what the test looks for is
 * the request in the retained bundle's network capture. `patchXhr` stays
 * off; this does not patch `fetch` either.
 */
import Bugsee from '@bugsee/react-native';

import { bugseeNamedUrl, deadEndpointUrl } from '../endpoint';

export const NETWORK_SCENARIOS = ['network'] as const;

export type NetworkScenario = (typeof NETWORK_SCENARIOS)[number];

export function isNetworkScenario(name: string): name is NetworkScenario {
  return (NETWORK_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E network ${message}`);
}

/**
 * The URL this scenario fetches. The host is the closed loopback the e2e
 * already uses (`DEAD_ENDPOINT`); the path carries the nonce so the bundle
 * assertion can tell this request from the SDK's own traffic to that host.
 * No "bugsee" in it (`deadEndpointUrl` refuses one): this is the probe that
 * is not about that word.
 */
export function fetchUrl(nonce: string): string {
  return deadEndpointUrl(`rn-e2e-fetch/${nonce}`);
}

/** The request with "bugsee" in its path and its query, for the same bundle. */
export function bugseeFetchUrl(nonce: string): string {
  return bugseeNamedUrl(nonce);
}

/** Called once the SDK reaches `Launched`. */
export async function runNetworkScenario(nonce: string): Promise<void> {
  const url = fetchUrl(nonce);
  mark(`fetching nonce=${nonce}`);
  try {
    const response = await fetch(url);
    mark(`fetched status=${response.status} nonce=${nonce}`);
  } catch (error) {
    mark(`fetch failed ${error instanceof Error ? error.message : String(error)} nonce=${nonce}`);
  }
  const named = bugseeFetchUrl(nonce);
  mark(`fetching named nonce=${nonce}`);
  try {
    const response = await fetch(named);
    mark(`fetched named status=${response.status} nonce=${nonce}`);
  } catch (error) {
    mark(`fetch named failed ${error instanceof Error ? error.message : String(error)} nonce=${nonce}`);
  }
  mark(`sent nonce=${nonce}`);
  Bugsee.upload(`network-${nonce}`, '');
}
