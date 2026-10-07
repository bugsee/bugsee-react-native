/**
 * The beta campaign's secret scan (plan N-29, FLOW-48, BLK-13), pure half:
 * which strings are secrets, every form they could take in a file, and
 * where they occur. scripts/cli-campaign-secret-scan.ts walks the files; the
 * device harness (examples/bare/e2e/bundles.ts) scans pulled bundles before
 * it deletes them.
 *
 * A finding names the secret's label (`placeholder`, `credentials.json
 * android`, ...), the form it was found in and the byte offset -- never the
 * value.
 */

/** The all-zero UUID token every offline run uses (examples/bare/endpoint.ts). */
export const PLACEHOLDER_TOKEN = '00000000-0000-4000-8000-000000000000';

export interface Secret {
  readonly label: string;
  readonly value: string;
}

export interface Needle {
  readonly label: string;
  /** e.g. `utf8`, `utf8 no-dash`, `utf16le upper`. */
  readonly form: string;
  readonly bytes: Buffer;
}

/** Shorter than this is not scanned for: it would match by accident. */
export const MIN_SECRET_LENGTH = 16;

/**
 * Every byte sequence a secret could appear as: as given, lower and upper
 * case, without dashes (a UUID token's other spelling), each in UTF-8,
 * UTF-16LE and UTF-16BE (Java's writeChars), and base64 of the UTF-8 form.
 */
export function needlesOf(secrets: readonly Secret[]): Needle[] {
  const needles: Needle[] = [];
  const seen = new Set<string>();
  for (const secret of secrets) {
    const value = secret.value.trim();
    if (value.length < MIN_SECRET_LENGTH) {
      continue;
    }
    const spellings = new Map<string, string>([
      ['', value],
      [' lower', value.toLowerCase()],
      [' upper', value.toUpperCase()],
    ]);
    if (value.includes('-')) {
      spellings.set(' no-dash', value.replace(/-/g, ''));
      spellings.set(' no-dash upper', value.replace(/-/g, '').toUpperCase());
    }
    for (const [suffix, text] of spellings) {
      const forms: Array<[string, Buffer]> = [
        [`utf8${suffix}`, Buffer.from(text, 'utf8')],
        [`utf16le${suffix}`, Buffer.from(text, 'utf16le')],
        [`utf16be${suffix}`, Buffer.from(text, 'utf16le').swap16()],
        [`base64${suffix}`, Buffer.from(Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, ''), 'utf8')],
      ];
      for (const [form, bytes] of forms) {
        const key = `${secret.label}\u0000${bytes.toString('hex')}`;
        if (!seen.has(key)) {
          seen.add(key);
          needles.push({ label: secret.label, form, bytes });
        }
      }
    }
  }
  return needles;
}

export interface Finding {
  readonly label: string;
  readonly form: string;
  readonly offset: number;
}

/** Every occurrence of every needle in `data` (at most `limit` per needle). */
export function scanBytes(data: Buffer, needles: readonly Needle[], limit = 5): Finding[] {
  const findings: Finding[] = [];
  for (const needle of needles) {
    let from = 0;
    for (let n = 0; n < limit; n += 1) {
      const at = data.indexOf(needle.bytes, from);
      if (at < 0) {
        break;
      }
      findings.push({ label: needle.label, form: needle.form, offset: at });
      from = at + 1;
    }
  }
  return findings;
}

/**
 * The secrets an app's credential files hold, labelled by where they came
 * from, plus the placeholder token. `json` is credentials.json's text and
 * `properties` android/bugsee.properties's, either possibly absent. Values
 * too short to scan for are left out.
 */
export function secretsOf(sources: ReadonlyArray<{ readonly origin: string; readonly json?: string; readonly properties?: string }>): Secret[] {
  const secrets: Secret[] = [{ label: 'placeholder', value: PLACEHOLDER_TOKEN }];
  for (const source of sources) {
    if (source.json !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(source.json);
      } catch {
        throw new Error(`${source.origin}: credentials.json is not JSON`);
      }
      for (const key of ['ios', 'android', 'token', 'appToken']) {
        const value = (parsed as Record<string, unknown> | null)?.[key];
        if (typeof value === 'string' && value.trim().length >= MIN_SECRET_LENGTH) {
          secrets.push({ label: `${source.origin} credentials.json ${key}`, value: value.trim() });
        }
      }
    }
    for (const line of (source.properties ?? '').split(/\r?\n/)) {
      const entry = /^\s*(app_token|plugin\.appToken)\s*[=:]\s*(\S+)\s*$/.exec(line);
      if (entry !== null && entry[2]!.length >= MIN_SECRET_LENGTH) {
        secrets.push({ label: `${source.origin} bugsee.properties ${entry[1]}`, value: entry[2]! });
      }
    }
  }
  return dedupe(secrets);
}

function dedupe(secrets: readonly Secret[]): Secret[] {
  const byValue = new Map<string, Secret>();
  for (const secret of secrets) {
    const known = byValue.get(secret.value);
    byValue.set(secret.value, known === undefined ? secret : { label: `${known.label} = ${secret.label}`, value: secret.value });
  }
  return [...byValue.values()];
}

/** One line per finding, safe to print and to keep: no value, only where. */
export function describeFinding(file: string, finding: Finding): string {
  return `SECRET-SCAN FOUND ${finding.label} (${finding.form}) in ${file} at byte ${finding.offset}`;
}

/** The marker a scan writes into a log when it found something (the CLI fails on it). */
export const FOUND_MARKER = /SECRET-SCAN FOUND /;

/**
 * `E2E_SECRET_SCAN_KNOWN`: comma-separated file base names whose findings are
 * a known, reported product issue (e.g. `.apptoken`, with its issue link in
 * the evidence). Only with a recorded decision: such a finding is still
 * printed, as `SECRET-SCAN KNOWN`, but does not fail the run.
 */
export function parseKnown(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '');
}

/** Whether `file`'s base name is one of `known`. */
export function isKnownFile(file: string, known: readonly string[]): boolean {
  const base = file.replace(/\\/g, '/').split('/').pop() ?? file;
  return known.includes(base);
}

/** The line for a finding in a known file: printed, kept, never failing. */
export function describeKnown(file: string, finding: Finding): string {
  return `SECRET-SCAN KNOWN ${finding.label} (${finding.form}) in ${file} at byte ${finding.offset}`;
}
