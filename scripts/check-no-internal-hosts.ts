/**
 * Fails when a tracked file names a `*.bugsee.com` host outside the public
 * allowlist. Internal hosts (staging and the like) must come from the
 * environment, never from this public repo; see BUGSEE_STAGING_ENDPOINT.
 *
 * The CLI is scripts/cli-check-no-internal-hosts.ts, run by `yarn lint`.
 */
/** Public hosts: the production API, the CLI installer's download host, the marketing site. */
export const ALLOWED_HOSTS: readonly string[] = ['api.bugsee.com', 'download.bugsee.com', 'www.bugsee.com'];

export interface HostFinding {
  readonly line: number;
  readonly host: string;
}

/** Every `*.bugsee.com` host in `text` that is not allowed, with its 1-based line. */
export function findInternalHosts(text: string, allowed: readonly string[] = ALLOWED_HOSTS): HostFinding[] {
  const found: HostFinding[] = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const match of lineText.matchAll(/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.bugsee\.com(?![a-z0-9-])/gi)) {
      if (!allowed.includes(match[0].toLowerCase())) {
        found.push({ line: index + 1, host: match[0] });
      }
    }
  });
  return found;
}
