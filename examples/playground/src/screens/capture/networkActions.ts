import Bugsee from '@bugsee/react-native';
import { PlaygroundNative } from '../../../modules/playground-native';
import { DEMO } from '../../demoApi';
import type { Action } from '../../ui/action';

const GET_EXPECT = 'A completed request with its status, headers and body in network capture';
const xhr = (method: string, body?: string) =>
  new Promise<number>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, DEMO.ECHO);
    x.timeout = 10000;
    x.onload = () => resolve(x.status);
    x.onerror = () => reject(new Error('XHR failed'));
    x.onabort = () => reject(new Error('XHR aborted'));
    x.ontimeout = () => reject(new Error('XHR timed out'));
    x.send(body);
  });

export const networkActions: Action[] = [
  {
    id: 'net-get',
    label: 'GET (fetch)',
    call: 'fetch(ECHO)',
    expect: GET_EXPECT,
    run: async () => (await fetch(DEMO.ECHO)).status,
  },
  {
    id: 'net-post-json',
    label: 'POST JSON',
    call: "fetch(ECHO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hello: 'world' }) })",
    expect: 'Request body {"hello":"world"} with a JSON content type',
    run: async () =>
      (
        await fetch(DEMO.ECHO, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hello: 'world' }),
        })
      ).status,
  },
  {
    id: 'net-post-form',
    label: 'POST form',
    call: "fetch(ECHO, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=two' })",
    expect: 'Request body a=1&b=two with content type application/x-www-form-urlencoded',
    run: async () =>
      (
        await fetch(DEMO.ECHO, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'a=1&b=two',
        })
      ).status,
  },
  {
    id: 'net-post-binary',
    label: 'POST binary (256 bytes)',
    call: "fetch(ECHO, { method: 'POST', body: new Uint8Array(256) })",
    expect: 'A request with a 256-byte binary body (body shown as binary or omitted)',
    run: async () =>
      (
        await fetch(DEMO.ECHO, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: Uint8Array.from({ length: 256 }, (_, i) => i) as never,
        })
      ).status,
  },
  {
    id: 'net-large',
    label: 'GET large (200 KB)',
    call: 'fetch(BYTES(200000))',
    expect: 'A completed GET whose response body is truncated or marked large in the report',
    run: async () => (await fetch(DEMO.BYTES(200000))).status,
  },
  {
    id: 'net-no-ctype',
    label: 'POST without Content-Type',
    call: "fetch(ECHO, { method: 'POST', body: <ArrayBuffer of 'raw text'> })",
    expect:
      'a POST whose request has no Content-Type header; its body is captured per the capture.network.body-without-type option',
    run: async () =>
      (
        await fetch(DEMO.ECHO, {
          method: 'POST',
          body: Uint8Array.from('raw text', (c) => c.charCodeAt(0)).buffer as never,
        })
      ).status,
  },
  {
    id: 'net-404',
    label: 'GET 404',
    call: 'fetch(STATUS(404))',
    expect: 'A request with responseCode 404 flagged as failed',
    run: async () => (await fetch(DEMO.STATUS(404))).status,
  },
  {
    id: 'net-503',
    label: 'GET 503',
    call: 'fetch(STATUS(503))',
    expect: 'A request with responseCode 503 flagged as failed',
    run: async () => (await fetch(DEMO.STATUS(503))).status,
  },
  {
    id: 'net-timeout',
    label: 'Timeout (abort after 2 s)',
    call: 'fetch(DELAY(10), { signal })',
    expect: 'A request that never completes or is marked cancelled; the result log shows an AbortError',
    run: async () => {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 2000);
      try {
        return (await fetch(DEMO.DELAY(10), { signal: c.signal })).status;
      } finally {
        clearTimeout(t);
      }
    },
  },
  {
    id: 'net-dns',
    label: 'DNS failure',
    call: 'fetch(DNS_FAIL)',
    expect: 'A failed request with an error description (host not found) and no response code',
    run: async () => (await fetch(DEMO.DNS_FAIL)).status,
  },
  { id: 'net-xhr-get', label: 'XHR GET', call: 'new XMLHttpRequest() GET', expect: GET_EXPECT, run: () => xhr('GET') },
  {
    id: 'net-xhr-post',
    label: 'XHR POST',
    call: 'new XMLHttpRequest() POST',
    expect: 'A POST with body {"xhr":true} in network capture',
    run: () => xhr('POST', '{"xhr":true}'),
  },
  {
    id: 'net-ws',
    label: 'WebSocket echo',
    call: 'new WebSocket(WS_ECHO)',
    expect: 'WebSocket open, a sent "ping", a received message and a close event in network capture',
    run: () =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(DEMO.WS_ECHO);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket timed out'));
        }, 10000);
        ws.onopen = () => ws.send('ping');
        ws.onmessage = (m) => {
          clearTimeout(timer);
          ws.close();
          resolve(String(m.data));
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error('WebSocket error'));
        };
      }),
  },
  {
    id: 'net-native-get',
    label: 'Native GET',
    call: "PlaygroundNative.request('GET', ECHO)",
    expect: 'URLSession (iOS) / OkHttp (Android) request in network capture',
    run: () => PlaygroundNative.request('GET', DEMO.ECHO),
  },
  {
    id: 'net-native-post',
    label: 'Native POST',
    call: `PlaygroundNative.request('POST', ECHO, '{"from":"native"}')`,
    expect: 'URLSession (iOS) / OkHttp (Android) request in network capture',
    run: () => PlaygroundNative.request('POST', DEMO.ECHO, '{"from":"native"}'),
  },
  {
    id: 'nf-redact',
    label: 'Network filter: redact Authorization',
    call: "Bugsee.setNetworkFilter((e) => ({ ...e, headers: …Authorization: '***' }))",
    expect: 'Later requests show Authorization: *** in their headers',
    run: () =>
      Bugsee.setNetworkFilter((e) => ({
        ...e,
        headers: e.headers ? { ...e.headers, Authorization: '***' } : e.headers,
      })),
  },
  {
    id: 'nf-send-auth',
    label: 'Send request with Authorization',
    call: "fetch(ECHO, { headers: { Authorization: 'Bearer demo' } })",
    expect: 'Authorization shows *** with the redact filter, Bearer demo without it',
    run: async () => (await fetch(DEMO.ECHO, { headers: { Authorization: 'Bearer demo' } })).status,
  },
  {
    id: 'nf-drop-status',
    label: 'Network filter: drop /status/ URLs',
    call: "Bugsee.setNetworkFilter((e) => (e.url?.includes('/status/') ? null : e))",
    expect: 'Later 404/503 requests are absent from the report; other requests remain',
    run: () => Bugsee.setNetworkFilter((e) => (e.url?.includes('/status/') ? null : e)),
  },
  {
    id: 'nf-off',
    label: 'Network filter: off',
    call: 'Bugsee.setNetworkFilter(null)',
    expect: 'Later requests are recorded unmodified',
    run: () => Bugsee.setNetworkFilter(null),
  },
  {
    id: 'net-add-event',
    label: 'Add a manual network event',
    call: "Bugsee.addNetworkEvent({ url: 'https://example.com/manual', … })",
    expect: 'A manual network event with responseCode 200 in the report',
    run: () =>
      Bugsee.addNetworkEvent({
        url: 'https://example.com/manual',
        method: 'GET',
        responseCode: 200,
        body: '{"manual":true}',
        headers: { 'X-Demo': '1' },
      }),
  },
];
