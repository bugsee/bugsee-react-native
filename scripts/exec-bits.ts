/**
 * Executable-bit guard for packed tarballs.
 *
 * `yarn pack` drops the executable bit from every file that is not a `bin` entry; `npm pack` keeps it.
 * 7.0.0-beta1 and beta2 were packed with yarn, so scripts/bugsee-xcode.sh and
 * scripts/hermesc-preserve-js.sh shipped as 0644: React Native's Hermes task execs hermesCommand
 * directly ("Permission denied" in every Release bundle) and the bare Xcode bundle phase execs the
 * script directly. The packing step now uses `npm pack`, and this check fails the release if a file
 * that git tracks as executable is not executable in the tarball.
 */

/** Paths (relative to the package) that `git ls-files -s` reports with mode 100755. */
export function executablePaths(lsFilesStage: string, packageDir: string): string[] {
  const prefix = `${packageDir.replace(/\/$/, '')}/`;
  return lsFilesStage
    .split('\n')
    .map((line) => /^100755 \S+ \d+\t(.+)$/.exec(line)?.[1])
    .filter((path): path is string => path !== undefined && path.startsWith(prefix))
    .map((path) => path.slice(prefix.length));
}

/** The expected-executable files that are missing from the tarball or not executable in it. */
export function missingExecBits(tarListing: string, executable: string[]): string[] {
  const modes = new Map<string, string>();
  for (const line of tarListing.split('\n')) {
    const match = /^(\S{10})\s+.*?\s(package\/\S.*)$/.exec(line);
    if (match) modes.set(match[2] as string, match[1] as string);
  }
  // Fail closed: a listing this parser cannot read (another tar's column layout, a changed format) would
  // otherwise leave every file "not found" and pass vacuously. package.json is always packed.
  if (!modes.has('package/package.json')) {
    throw new Error('could not read the tar listing: package/package.json not found in it');
  }
  return executable.filter((path) => {
    const mode = modes.get(`package/${path}`);
    return mode === undefined ? false : mode[3] !== 'x';
  });
}
