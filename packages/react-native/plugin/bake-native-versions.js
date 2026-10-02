/**
 * Copy android.sdk and android.gradlePlugin from the repo-root
 * native-versions.json into plugin/build. The published package cannot
 * ship the repo-root file, so the plugin reads this copy at runtime.
 */
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const repoRoot = join(__dirname, '..', '..', '..');
const source = join(repoRoot, 'native-versions.json');
const parsed = JSON.parse(readFileSync(source, 'utf8'));
const sdk = parsed.android && parsed.android.sdk;
const gradlePlugin = parsed.android && parsed.android.gradlePlugin;
if (typeof sdk !== 'string' || typeof gradlePlugin !== 'string') {
  throw new Error(`${source} is missing android.sdk or android.gradlePlugin`);
}
if (!/^[0-9A-Za-z.+_-]+$/.test(sdk) || !/^[0-9A-Za-z.+_-]+$/.test(gradlePlugin)) {
  throw new Error(`refusing to bake native versions from ${source}`);
}

const out = join(__dirname, 'build', 'native-versions.baked.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ sdk, gradlePlugin }, null, 2)}\n`);
