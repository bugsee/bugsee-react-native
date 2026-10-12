/**
 * argv/exit shim for the harness's fail-closed iPhone check, for
 * scripts/run-ios.sh: `IOS_DEVICE_ID` must be on device.ts's allowlist, and
 * `devicectl list devices` must show it as the allowlisted model and UDID
 * (`verifyIosDevice`, the check every e2e devicectl call waits on). Exit 0 on
 * success, 1 with the reason otherwise.
 *
 * Run by Node's type stripping (22.18+), which loads device.ts as an ES
 * module. device.ts is written for ts-jest's CommonJS and reads `__dirname`
 * once at load; an ES module has no such binding, so the name is resolved
 * through the global object, set here to device.ts's own directory before the
 * dynamic import.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

(globalThis as { __dirname?: string }).__dirname = dirname(fileURLToPath(import.meta.url));

try {
  const { verifyIosDevice } = await import('./device.ts');
  console.log(`verified iPhone ${await verifyIosDevice()}`);
} catch (error) {
  console.error(`iPhone identity check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
