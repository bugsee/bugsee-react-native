import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AndroidNativeVersions {
  readonly sdk: string;
  readonly gradlePlugin: string;
}

interface NativeVersionsFile {
  readonly android?: {
    readonly sdk?: string;
    readonly gradlePlugin?: string;
  };
}

/**
 * Walk up from the plugin until `native-versions.json` appears. That file
 * is the only pin: the Gradle plugin version is `android.gradlePlugin` and
 * the NDK artifact version is `android.sdk`.
 */
export function loadNativeVersions(startDir: string): AndroidNativeVersions {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, 'native-versions.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as NativeVersionsFile;
      const sdk = parsed.android?.sdk;
      const gradlePlugin = parsed.android?.gradlePlugin;
      if (!sdk || !gradlePlugin) {
        throw new Error(`${candidate} is missing android.sdk or android.gradlePlugin`);
      }
      return { sdk, gradlePlugin };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`native-versions.json not found above ${startDir}`);
}
