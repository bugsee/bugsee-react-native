/**
 * Task 9.6: an app records a network event the SDK did not capture.
 *
 * The filter is installed before `launch()`. After launch the app calls
 * `Bugsee.addNetworkEvent` twice. The first url carries the nonce and is
 * kept. The second url's filter never settles, so the SDK drops it. This
 * scenario does not patch fetch or XHR, and it does not add a timeout that
 * would pass the hung event through. `duration` stays the app's 90.
 */
import Bugsee, { type NetworkFilterEvent } from '@bugsee/react-native';

export const ADD_NETWORK_EVENT_SCENARIOS = ['add-network-event'] as const;

export type AddNetworkEventScenario = (typeof ADD_NETWORK_EVENT_SCENARIOS)[number];

export function isAddNetworkEventScenario(name: string): name is AddNetworkEventScenario {
  return (ADD_NETWORK_EVENT_SCENARIOS as readonly string[]).includes(name);
}

export function keptNetworkEventUrl(nonce: string): string {
  return `https://bugsee-e2e.invalid/add/${nonce}`;
}

export function hungNetworkEventUrl(nonce: string): string {
  return `https://bugsee-e2e.invalid/hang/${nonce}`;
}

function mark(message: string): void {
  console.log(`BUGSEE_E2E add-network-event ${message}`);
}

const UPLOAD_AFTER_MS = 5_000;

interface Slots {
  kept: boolean;
  hung: boolean;
  onReady?: () => void;
}

let slots: Slots = { kept: false, hung: false };

function noteReady(): void {
  if (!(slots.kept && slots.hung && slots.onReady !== undefined)) {
    return;
  }
  const ready = slots.onReady;
  slots.onReady = undefined;
  ready();
}

function urlOf(event: NetworkFilterEvent): string {
  return typeof event.url === 'string' ? event.url : '';
}

/**
 * Called before `launch()`. Registration finishes before this returns.
 */
export function installAddNetworkEventFilter(nonce: string): void {
  slots = { kept: false, hung: false };
  const kept = keptNetworkEventUrl(nonce);
  const hung = hungNetworkEventUrl(nonce);
  Bugsee.setNetworkFilter((event) => {
    const url = urlOf(event);
    if (url === hung && !slots.hung) {
      slots.hung = true;
      mark(`hung nonce=${nonce}`);
      noteReady();
      return new Promise(() => {});
    }
    if (url === kept && !slots.kept) {
      slots.kept = true;
      mark(`kept nonce=${nonce}`);
      noteReady();
      return event;
    }
    return event;
  });
  mark(`filter installed nonce=${nonce}`);
}

/**
 * Called once the SDK reaches `Launched`. Records the kept event and the
 * one whose filter never settles, then uploads.
 */
export function runAddNetworkEventScenario(nonce: string): void {
  Bugsee.addNetworkEvent({
    url: keptNetworkEventUrl(nonce),
    method: 'GET',
    stage: 'completed',
  });
  Bugsee.addNetworkEvent({
    url: hungNetworkEventUrl(nonce),
    method: 'GET',
    stage: 'completed',
  });
  mark(`recorded nonce=${nonce}`);

  let uploaded = false;
  const upload = (): void => {
    if (uploaded) {
      return;
    }
    uploaded = true;
    setTimeout(() => {
      Bugsee.upload(`add-network-event-${nonce}`, '');
      mark(`uploaded nonce=${nonce}`);
    }, UPLOAD_AFTER_MS);
  };
  if (slots.kept && slots.hung) {
    upload();
    return;
  }
  slots.onReady = upload;
  setTimeout(() => {
    if (slots.kept && slots.hung) {
      return;
    }
    mark(`no-candidate kept=${String(slots.kept)} hung=${String(slots.hung)} nonce=${nonce}`);
    slots.onReady = undefined;
    upload();
  }, 8_000);
}
