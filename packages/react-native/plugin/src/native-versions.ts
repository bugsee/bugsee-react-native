import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AndroidNativeVersions {
  readonly sdk: string;
  readonly gradlePlugin: string;
}

interface BakedVersions {
  readonly sdk?: string;
  readonly gradlePlugin?: string;
}

/**
 * `build:plugin` copies `android.sdk` and `android.gradlePlugin` from the
 * repo-root native-versions.json into `native-versions.baked.json` beside
 * this module. A published install has no repo-root JSON to walk to.
 */
export function loadNativeVersions(moduleDir: string = __dirname): AndroidNativeVersions {
  const file = join(moduleDir, 'native-versions.baked.json');
  let parsed: BakedVersions;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as BakedVersions;
  } catch (error) {
    throw new Error(`baked native versions not found at ${file}`, { cause: error });
  }
  const sdk = parsed.sdk;
  const gradlePlugin = parsed.gradlePlugin;
  if (!sdk || !gradlePlugin) {
    throw new Error(`${file} is missing sdk or gradlePlugin`);
  }
  return { sdk, gradlePlugin };
}
