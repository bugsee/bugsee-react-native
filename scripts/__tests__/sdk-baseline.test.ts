import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkBaseline, parseBaseline } from '../published-manifest';

const root = join(__dirname, '..', '..');
const baseline = parseBaseline(readFileSync(join(root, 'scripts', 'sdk-baseline.json'), 'utf8'), 'scripts/sdk-baseline.json');
const pinned = JSON.parse(readFileSync(join(root, 'native-versions.json'), 'utf8')) as {
  android: { sdk: string };
  ios: { sdk: string };
};

/**
 * The offline half of the removal check. The check itself compares the previous pin's published manifest
 * with the current one and needs the network; this fails the plain test run the moment the pin moves
 * without the baseline, so a bump cannot skip the removal comparison by forgetting to update it.
 */
describe('scripts/sdk-baseline.json', () => {
  it.each(['android', 'ios'] as const)('describes the %s pin in native-versions.json', (platform) => {
    expect(checkBaseline(platform, baseline[platform], pinned[platform].sdk)).toEqual([]);
  });

  it('acknowledges removals only with a reason', () => {
    for (const entry of baseline.acknowledgedRemovals) {
      expect(entry.reason.trim()).not.toBe('');
    }
  });
});
