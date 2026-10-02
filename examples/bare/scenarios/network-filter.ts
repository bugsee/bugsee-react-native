/**
 * The network-filter scenario Task 9.4 drives on a device
 * (e2e/network-filter.test.ts).
 *
 * The filter is installed before `launch()`. The first websocket event native
 * capture records is rewritten: its url gains `bugsee-e2e-redacted=<nonce>`.
 * The SDK's own `POST /v2/sessions` `error` event's callback never settles,
 * so the SDK drops it. Stages of one request share an id; the hang is that
 * error stage. This scenario does not add a timeout that would pass the
 * event through, and it does not make a request of its own.
 *
 * The upload waits long enough for the rewrite's round trip to be recorded,
 * and not long enough for a second, local timeout to matter: the recording
 * `duration` stays the app's 90.
 */
import Bugsee, { type NetworkFilterEvent } from '@bugsee/react-native';

export const NETWORK_FILTER_SCENARIOS = ['network-filter'] as const;

export type NetworkFilterScenario = (typeof NETWORK_FILTER_SCENARIOS)[number];

export function isNetworkFilterScenario(name: string): name is NetworkFilterScenario {
  return (NETWORK_FILTER_SCENARIOS as readonly string[]).includes(name);
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E network-filter ${message}`);
}

/** How long to wait, after both probes have been decided, before uploading. */
const UPLOAD_AFTER_MS = 5_000;

interface Slots {
  rewrote: boolean;
  hung: boolean;
  onReady?: () => void;
}

let slots: Slots = { rewrote: false, hung: false };

function noteReady(): void {
  if (!(slots.rewrote && slots.hung && slots.onReady !== undefined)) {
    return;
  }
  const ready = slots.onReady;
  slots.onReady = undefined;
  ready();
}

function idOf(event: NetworkFilterEvent): string | undefined {
  return typeof event.id === 'string' && event.id.length > 0 ? event.id : undefined;
}

function urlOf(event: NetworkFilterEvent): string {
  return typeof event.url === 'string' ? event.url : '';
}

/**
 * Called before `launch()`. Registration finishes before this returns, so a
 * later Bugsee call on the same turn already sees the filter.
 */
export function installNetworkFilter(nonce: string): void {
  slots = { rewrote: false, hung: false };
  Bugsee.setNetworkFilter((event) => {
    const id = idOf(event);
    const url = urlOf(event);
    const sessions = url.includes('/v2/sessions');
    if (id !== undefined && event.type === 'websocket' && !slots.rewrote) {
      slots.rewrote = true;
      const joiner = url.includes('?') ? '&' : '?';
      const next = `${url}${joiner}bugsee-e2e-redacted=${nonce}`;
      mark(`rewrote id=${id} nonce=${nonce}`);
      noteReady();
      return { ...event, url: next };
    }
    if (id !== undefined && sessions && event.type === 'error' && !slots.hung) {
      slots.hung = true;
      mark(`hung id=${id} type=error nonce=${nonce}`);
      noteReady();
      return new Promise(() => {});
    }
    return event;
  });
  mark(`filter installed nonce=${nonce}`);
}

/**
 * Called once the SDK reaches `Launched`. Uploads after both probes have
 * been decided. If the session events never arrive, it still uploads and
 * says so: the bundle then shows what capture recorded, and the e2e does
 * not treat that as a rewritten event.
 */
export function runNetworkFilterScenario(nonce: string): void {
  let uploaded = false;
  const upload = (): void => {
    if (uploaded) {
      return;
    }
    uploaded = true;
    setTimeout(() => {
      Bugsee.upload(`network-filter-${nonce}`, '');
      mark(`uploaded nonce=${nonce}`);
    }, UPLOAD_AFTER_MS);
  };
  if (slots.rewrote && slots.hung) {
    upload();
    return;
  }
  slots.onReady = upload;
  // If capture records nothing this process can filter, say so and still
  // upload. The bundle then shows what was recorded; the e2e does not treat
  // an empty capture as a rewritten event.
  setTimeout(() => {
    if (slots.rewrote && slots.hung) {
      return;
    }
    mark(`no-candidate rewrote=${String(slots.rewrote)} hung=${String(slots.hung)} nonce=${nonce}`);
    slots.onReady = undefined;
    upload();
  }, 8_000);
}
