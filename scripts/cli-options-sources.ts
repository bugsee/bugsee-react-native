/** What the option checks and the doc generator read from this repository. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAccessors, type AccessorInfo } from './option-accessors.ts';
import {
  parseBaseline,
  parseManifest,
  type PublishedManifest,
  type SdkBaseline,
  type PublishedOption,
} from './published-manifest.ts';

export const root = join(import.meta.dirname, '..');
export const optionsDir = join(root, 'packages', 'react-native', 'src', 'options');
export const docPath = join(root, 'docs', 'launch-options.md');

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export const pinned = readJson<{ android: { sdk: string }; ios: { sdk: string } }>(
  join(root, 'native-versions.json'),
);
export const keys = readJson<{ shared: string[]; ios: string[]; android: string[] }>(
  join(optionsDir, 'option-keys.json'),
);

/** The pin before the current one, and the removals already dealt with (scripts/sdk-baseline.json). */
export function readBaseline(): SdkBaseline {
  return parseBaseline(readFileSync(join(root, 'scripts', 'sdk-baseline.json'), 'utf8'), 'scripts/sdk-baseline.json');
}

export const fixtureName = (platform: 'android' | 'ios'): string => `${platform}-options-manifest.json`;

/**
 * A committed copy of a manifest, read as strictly as the published one: a file that is `{}` or has
 * malformed rows must fail the check, not turn the comparison against it into a no-op.
 */
export function readFixture(platform: 'android' | 'ios'): PublishedManifest {
  const name = fixtureName(platform);
  return parseManifest(readFileSync(join(optionsDir, name), 'utf8'), name);
}

export function fixtureOptions(platform: 'android' | 'ios'): PublishedOption[] {
  return readFixture(platform).options;
}

/** Every accessor, with the class that declares it. */
export function readAccessors(): AccessorInfo[] {
  const file = (name: string, owner: 'base' | 'android' | 'ios'): AccessorInfo[] =>
    parseAccessors(readFileSync(join(optionsDir, `${name}.ts`), 'utf8'), owner);
  return [
    ...file('BugseeLaunchOptions', 'base'),
    ...file('AndroidLaunchOptions', 'android'),
    ...file('IOSLaunchOptions', 'ios'),
  ];
}

/** The accessors reachable on one platform's options class. */
export function accessorsFor(all: readonly AccessorInfo[], platform: 'android' | 'ios'): AccessorInfo[] {
  return all.filter((accessor) => accessor.owner === 'base' || accessor.owner === platform);
}

export async function readEnums(): Promise<{
  enums: Record<string, Record<string, unknown>>;
  withheld: Record<string, Record<string, unknown>>;
}> {
  const module = (await import(pathToFileURL(join(optionsDir, 'enums.ts')).href)) as Record<string, unknown>;
  const withheld = module.WITHHELD_FROM_JS as Record<string, Record<string, unknown>>;
  const enums = Object.fromEntries(
    Object.entries(module).filter(([name]) => name !== 'WITHHELD_FROM_JS'),
  ) as Record<string, Record<string, unknown>>;
  return { enums, withheld };
}

export async function readNoAccessor(): Promise<Record<string, string>> {
  const module = (await import(pathToFileURL(join(optionsDir, 'noAccessor.ts')).href)) as {
    NO_ACCESSOR: Record<string, string>;
  };
  return module.NO_ACCESSOR;
}
