import fs from 'node:fs';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Tokens = { ios?: string; android?: string };
/** The all-zero placeholder CI builds with: valid UUID syntax, but no real app. */
export const PLACEHOLDER_TOKEN = '00000000-0000-4000-8000-000000000000';

export interface ResolvedBugseeConfig {
  pluginProps: { appToken?: Tokens; endpoint?: string; symbolicateReactNativeFrameworks?: boolean };
  /** `bugseeEndpoint` is the build's endpoint (not a secret): Setup shows what an empty field launches against. */
  extra: { bugseeTokenPrefix: Tokens; bugseeEndpoint?: string };
}

export function readBugseeConfigFile(dir: string): unknown {
  const file = path.join(dir, 'bugsee.config.json');
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function token(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value.trim()) ? value.trim() : undefined;
}

export function resolveBugseeConfig(input: {
  file?: unknown;
  env: Record<string, string | undefined>;
}): ResolvedBugseeConfig {
  const file = input.file !== null && typeof input.file === 'object' ? (input.file as Record<string, unknown>) : {};
  const raw = file.appToken;
  const fromFile: Tokens =
    typeof raw === 'string'
      ? { ios: token(raw), android: token(raw) }
      : raw !== null && typeof raw === 'object'
        ? { ios: token((raw as Tokens).ios), android: token((raw as Tokens).android) }
        : {};
  const shared = token(input.env.BUGSEE_APP_TOKEN);
  const tokens: Tokens = {};
  const ios = fromFile.ios ?? shared ?? token(input.env.BUGSEE_TOKEN_IOS);
  const android = fromFile.android ?? shared;
  if (ios) tokens.ios = ios;
  if (android) tokens.android = android;

  const pluginProps: ResolvedBugseeConfig['pluginProps'] = {};
  if (tokens.ios || tokens.android) pluginProps.appToken = tokens;
  if (typeof file.endpoint === 'string' && file.endpoint.trim() !== '') pluginProps.endpoint = file.endpoint.trim();
  if (typeof file.symbolicateReactNativeFrameworks === 'boolean') {
    pluginProps.symbolicateReactNativeFrameworks = file.symbolicateReactNativeFrameworks;
  }
  // The hint only: the placeholder still reaches pluginProps (the plugin handles it), but Setup must not show
  // "Build-time token configured: 00000000…" for it.
  const real = (t?: string) => (t && t.toLowerCase() !== PLACEHOLDER_TOKEN ? t : undefined);
  const prefix: Tokens = {};
  if (real(tokens.ios)) prefix.ios = tokens.ios!.slice(0, 8);
  if (real(tokens.android)) prefix.android = tokens.android!.slice(0, 8);
  const extra: ResolvedBugseeConfig['extra'] = { bugseeTokenPrefix: prefix };
  if (pluginProps.endpoint) extra.bugseeEndpoint = pluginProps.endpoint;
  return { pluginProps, extra };
}
