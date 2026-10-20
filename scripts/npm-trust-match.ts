/**
 * Decides whether an existing npm trusted-publisher entry is the one the release needs.
 *
 * True only when ONE entry names this repository, workflow file and environment (exact values, not
 * substrings of the whole output) and grants plain publish rather than only staged publish.
 * Anything unparseable counts as "not ours": failing costs a manual look, passing wrongly leaves a
 * release that npm rejects.
 *
 * The field names of `npm trust list --json` are not documented and could not be captured before the
 * first package existed, so this matches on values and on any key naming a publish permission. It is
 * a guess until a real listing is captured; the tests pin the near misses it must reject, and the
 * first real listing should be added to them.
 */
export interface TrustTarget {
  repo: string;
  file: string;
  environment: string;
}

export function matchesTrust(listed: string, target: TrustTarget): boolean {
  let data: unknown;
  try {
    data = JSON.parse(listed);
  } catch {
    return false;
  }
  const entries: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      entries.push(node as Record<string, unknown>);
      Object.values(node).forEach(walk);
    }
  };
  walk(data);
  return entries.some((entry) => {
    const values = Object.values(entry);
    if (![target.repo, target.file, target.environment].every((part) => values.includes(part)))
      return false;
    const keyed = Object.entries(entry).some(
      ([key, value]) => /publish/i.test(key) && !/stage/i.test(key) && value === true,
    );
    const listedPermission = values.some((value) => Array.isArray(value) && value.includes('publish'));
    return keyed || listedPermission;
  });
}
