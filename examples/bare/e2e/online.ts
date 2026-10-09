/**
 * The network ON, stated and checked (campaign N-16, N-19). Android: airplane
 * mode off and an active default network; iOS has no switch the harness can
 * turn (the simulator shares the Mac's network; the iPhone's airplane mode is
 * an operator step), so there it is a no-op.
 */
import { airplane } from './bundles';
import { ON_ANDROID, report } from './harness';
import { adbStatus } from './scenario';

export async function ensureOnline(): Promise<void> {
  if (!ON_ANDROID) {
    return;
  }
  await airplane(false);
  const deadline = Date.now() + 30_000;
  let active: string | undefined;
  let output = '';
  while (Date.now() < deadline) {
    output = (await adbStatus('shell', 'dumpsys', 'connectivity')).output;
    active = /Active default network: (\S+)/.exec(output)?.[1];
    if (active !== undefined && active !== 'none') {
      report('active default network', active);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`the handset has no active network 30 s after airplane mode went off:\n${output.slice(0, 1500)}`);
}
