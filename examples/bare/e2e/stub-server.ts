/**
 * A local HTTP stub the device suites point the app's own requests at
 * (campaign N-12): status codes on demand, an echo, a payload of a given
 * size, and a record of every request it saw. Never a Bugsee endpoint.
 *
 * Routes (any method):
 *   /status/<code>[/<anything>]     responds <code> (100-599) with a small JSON body
 *   /delay/<ms>/status/<code>[/...] the same, after <ms> (at most 30000)
 *   /echo[/<anything>]              200, JSON of the request's method, path, headers and body
 *   /bytes/<n>                      200, <n> bytes of 'x' (at most 10 MB), no Content-Type
 *   anything else                   404
 *
 * Reaching it from the app (`deviceStubUrl`):
 *   Android   `adb reverse tcp:8899 tcp:<port>`; the app asks http://127.0.0.1:8899
 *             (scenarios/stub.ts), so the device side never changes.
 *   simulator http://127.0.0.1:<port>: the simulator shares the Mac's loopback.
 *   iPhone    http://<this Mac's LAN address>:<port>; the server then listens on
 *             every interface, and the phone needs Local Network permission.
 * iOS receives the URL as the launch argument `-bugseeE2eStub` (startRun's
 * `stub` option); Android needs nothing.
 *
 * Plain http: an Android Debug build allows cleartext, a Release build does
 * not (`usesCleartextTraffic`), so the stub is for Debug runs on Android.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';

import { iosTarget } from './device';
import { adb } from './scenario';

/** The port the Android app always asks for (scenarios/stub.ts). */
export const ANDROID_STUB_PORT = 8899;

export interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  /** Epoch ms, this Mac's clock. */
  readonly at: number;
  /** The status the stub answered with. */
  readonly status: number;
}

export interface StubServer {
  readonly port: number;
  readonly host: string;
  /** Every request so far, oldest first. */
  readonly requests: readonly StubRequest[];
  /** The first request at or after index `from` whose path matches, or undefined on timeout. */
  waitFor(path: RegExp, timeoutMs: number, from?: number): Promise<StubRequest | undefined>;
  close(): Promise<void>;
}

export interface StubRoute {
  readonly status: number;
  readonly delayMs: number;
  readonly body: string;
  readonly contentType?: string;
}

/** What the stub answers for `method` `path` (with the request body `body`). Pure: unit-tested. */
export function routeOf(method: string, path: string, headers: StubRequest['headers'], body: string): StubRoute {
  const bare = path.split('?')[0]!;
  const delayed = /^\/delay\/(\d{1,5})(\/status\/.*)$/.exec(bare);
  if (delayed !== null) {
    const delayMs = Number(delayed[1]);
    if (delayMs > 30_000) {
      return { status: 400, delayMs: 0, body: '{"error":"delay over 30000 ms"}', contentType: 'application/json' };
    }
    return { ...routeOf(method, delayed[2]!, headers, body), delayMs };
  }
  const status = /^\/status\/(\d{3})(\/.*)?$/.exec(bare);
  if (status !== null) {
    const code = Number(status[1]);
    if (code < 100 || code > 599) {
      return { status: 400, delayMs: 0, body: '{"error":"status out of range"}', contentType: 'application/json' };
    }
    return { status: code, delayMs: 0, body: JSON.stringify({ status: code, path }), contentType: 'application/json' };
  }
  if (bare === '/echo' || bare.startsWith('/echo/')) {
    return {
      status: 200,
      delayMs: 0,
      body: JSON.stringify({ method, path, headers, body }),
      contentType: 'application/json',
    };
  }
  const bytes = /^\/bytes\/(\d{1,8})$/.exec(bare);
  if (bytes !== null) {
    const n = Number(bytes[1]);
    if (n > 10 * 1024 * 1024) {
      return { status: 400, delayMs: 0, body: '{"error":"over 10 MB"}', contentType: 'application/json' };
    }
    return { status: 200, delayMs: 0, body: 'x'.repeat(n) };
  }
  return { status: 404, delayMs: 0, body: '{"error":"no such route"}', contentType: 'application/json' };
}

/**
 * Starts the stub on `port` (0: any free port). `host` defaults to loopback;
 * the iPhone needs `0.0.0.0` (`deviceStubUrl` restarts nothing: start the
 * server with `startStubServerFor()` instead, which picks the host).
 */
export async function startStubServer(options: { host?: string; port?: number } = {}): Promise<StubServer> {
  const host = options.host ?? '127.0.0.1';
  const requests: StubRequest[] = [];
  let waiters: Array<() => void> = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = request.url ?? '/';
      const method = request.method ?? 'GET';
      const route = routeOf(method, path, request.headers, body);
      requests.push({ method, path, headers: request.headers, body, at: Date.now(), status: route.status });
      const wake = waiters;
      waiters = [];
      for (const fn of wake) {
        fn();
      }
      setTimeout(() => {
        const headers: Record<string, string> = { 'Content-Length': String(Buffer.byteLength(route.body)) };
        if (route.contentType !== undefined) {
          headers['Content-Type'] = route.contentType;
        }
        response.writeHead(route.status, headers);
        response.end(route.body);
      }, route.delayMs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    host,
    requests,
    async waitFor(path: RegExp, timeoutMs: number, from = 0): Promise<StubRequest | undefined> {
      const deadline = Date.now() + timeoutMs;
      for (let scanned = from; ; ) {
        for (; scanned < requests.length; scanned += 1) {
          if (path.test(requests[scanned]!.path)) {
            return requests[scanned];
          }
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          return undefined;
        }
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** This Mac's first non-internal IPv4 address (en0 first), or undefined. */
export function lanAddress(interfaces = networkInterfaces()): string | undefined {
  const names = Object.keys(interfaces).sort((a, b) => (a === 'en0' ? -1 : b === 'en0' ? 1 : a.localeCompare(b)));
  for (const name of names) {
    for (const entry of interfaces[name] ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return undefined;
}

/** Starts a stub reachable from the configured target (`E2E_PLATFORM`, `E2E_IOS_TARGET`). */
export async function startStubServerFor(platform: 'android' | 'ios'): Promise<StubServer> {
  const phone = platform === 'ios' && iosTarget() === 'device';
  return startStubServer({ host: phone ? '0.0.0.0' : '127.0.0.1' });
}

/**
 * The stub's base URL as the app must ask for it, after setting up whatever
 * the target needs (Android: the reverse tunnel). Pass it to startRun's
 * `stub` option on iOS.
 */
export async function deviceStubUrl(server: StubServer, platform: 'android' | 'ios'): Promise<string> {
  if (platform === 'android') {
    await adb('reverse', `tcp:${ANDROID_STUB_PORT}`, `tcp:${server.port}`);
    return `http://127.0.0.1:${ANDROID_STUB_PORT}`;
  }
  if (iosTarget() === 'simulator') {
    return `http://127.0.0.1:${server.port}`;
  }
  const address = lanAddress();
  if (address === undefined) {
    throw new Error('deviceStubUrl: this Mac has no LAN IPv4 address for the iPhone to reach');
  }
  return `http://${address}:${server.port}`;
}

/** Removes the Android tunnel `deviceStubUrl` set up; not set up is fine. */
export async function releaseDeviceStub(platform: 'android' | 'ios'): Promise<void> {
  if (platform === 'android') {
    await adb('reverse', '--remove', `tcp:${ANDROID_STUB_PORT}`).catch(() => {});
  }
}
