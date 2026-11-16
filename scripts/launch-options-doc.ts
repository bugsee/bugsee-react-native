/**
 * Renders the launch-option reference (docs/launch-options.md) from the accessor classes and the SDKs'
 * published manifests, so the type, platform and default of every option in the docs is the SDK's own
 * and cannot be written from memory. The build fails when the committed file differs from this output.
 */
import type { PublishedManifest, PublishedOption } from './published-manifest.ts';
import type { AccessorInfo } from './option-accessors.ts';

export const REFERENCE_MARKER = '## Reference';

/** A manifest default as it reads in a table cell. */
export function formatDefault(option: PublishedOption): string {
  const value = option.default;
  if (value === null || value === undefined) {
    return 'unset';
  }
  if (option.type === 'enum') {
    return `\`${String(value)}\``;
  }
  return `\`${JSON.stringify(value)}\``;
}

function typeLabel(option: PublishedOption): string {
  return option.type === 'enum' ? `enum ${option.enum?.name ?? ''}` : option.type;
}

const GROUPS: readonly [title: string, prefixes: readonly string[]][] = [
  ['Reporting triggers and dialog', ['reporting.']],
  ['Capture', ['capture.']],
  ['Detection', ['detect.', 'crash-ndk.']],
  ['Configuration', ['config.']],
  ['Performance', ['performance.']],
];

const PREFIX = 'com.bugsee.option.';

export interface DocInput {
  /** The committed text up to and including the Reference marker line; kept as written. */
  head: string;
  android: PublishedManifest;
  ios: PublishedManifest;
  accessors: readonly AccessorInfo[];
  noAccessor: Readonly<Record<string, string>>;
}

/** Text for a table cell: the backslash first, so an escape written in the text is not undone by ours. */
export function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** The default cell: one value when the platforms agree, both labelled when they differ. */
export function defaultCell(android: PublishedOption | undefined, ios: PublishedOption | undefined): string {
  if (android && ios) {
    const a = formatDefault(android);
    const i = formatDefault(ios);
    return a === i ? a : `Android ${a} · iOS ${i}`;
  }
  return formatDefault((android ?? ios) as PublishedOption);
}

export function renderDoc(input: DocInput): string {
  const { head, android, ios, accessors, noAccessor } = input;
  const a = new Map(android.options.map((option) => [option.key, option]));
  const i = new Map(ios.options.map((option) => [option.key, option]));
  const out: string[] = [head.trimEnd(), ''];
  const placed = new Set<string>();

  for (const [title, prefixes] of GROUPS) {
    const rows = accessors
      .filter((accessor) => prefixes.some((prefix) => accessor.key.startsWith(PREFIX + prefix)))
      .sort((x, y) => x.key.localeCompare(y.key));
    if (rows.length === 0) {
      continue;
    }
    out.push(`### ${title}`, '', '| Accessor | Option key | Type | Platforms | Default | Notes |', '|---|---|---|---|---|---|');
    for (const accessor of rows) {
      placed.add(accessor.key);
      const onAndroid = a.get(accessor.key);
      const onIos = i.get(accessor.key);
      const option = onAndroid ?? onIos;
      // An option of this package's own is in no SDK manifest: its type is the accessor's, it names no
      // platform's SDK, and it has no SDK default to quote.
      const type = option === undefined ? accessor.type : typeLabel(option);
      const platforms =
        option === undefined ? 'React Native only' : onAndroid && onIos ? 'iOS, Android' : onAndroid ? 'Android' : 'iOS';
      const notes = [accessor.doc, accessor.deprecated ? `**Deprecated** — ${accessor.deprecated}` : '']
        .filter(Boolean)
        .join(' ');
      out.push(
        `| \`${accessor.name}\` | \`${accessor.key}\` | \`${type}\` | ${platforms} | ${option === undefined ? 'unset' : defaultCell(onAndroid, onIos)} | ${cell(notes)} |`,
      );
    }
    out.push('');
  }

  const stray = accessors.filter((accessor) => !placed.has(accessor.key)).map((accessor) => accessor.key);
  if (stray.length > 0) {
    throw new Error(`accessors with a key outside every documented group: ${stray.join(', ')}`);
  }

  out.push('### Not exposed on purpose', '');
  for (const [key, reason] of Object.entries(noAccessor)) {
    out.push(`- \`${key}\`: ${reason}.`);
  }
  out.push('');
  return out.join('\n');
}

/**
 * The hand-written part of the committed document: everything before the first generated group, so
 * the heading and the sentence under it stay as written. An error when there is no marker or no group.
 */
export function readHead(document: string): string {
  const marker = document.indexOf(REFERENCE_MARKER);
  if (marker === -1) {
    throw new Error(`the launch-options document has no "${REFERENCE_MARKER}" heading to regenerate from`);
  }
  const firstGroup = document.indexOf('\n### ', marker);
  if (firstGroup === -1) {
    throw new Error('the launch-options document has no "###" group after its Reference heading');
  }
  return `${document.slice(0, firstGroup).trimEnd()}\n`;
}
