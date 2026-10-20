import { executablePaths, missingExecBits } from '../exec-bits';

describe('executablePaths', () => {
  it('lists the files git tracks as executable inside one package, relative to it', () => {
    const stage = [
      '100755 abc 0\tpackages/react-native/scripts/bugsee-xcode.sh',
      '100644 def 0\tpackages/react-native/scripts/hermes-sourcemaps.js',
      '100755 123 0\tpackages/react-native-feedback/bin/x.sh',
      '100755 456 0\tpackages/react-native/scripts/hermesc-preserve-js.sh',
    ].join('\n');
    expect(executablePaths(stage, 'packages/react-native')).toEqual([
      'scripts/bugsee-xcode.sh',
      'scripts/hermesc-preserve-js.sh',
    ]);
  });

  it('does not match a sibling package that shares a prefix', () => {
    expect(executablePaths('100755 a 0\tpackages/react-native-feedback/x.sh', 'packages/react-native')).toEqual([]);
  });
});

describe('missingExecBits', () => {
  const listing = (mode: string) =>
    `${mode} 0/0 100 1985-10-26 08:15 package/scripts/bugsee-xcode.sh\n-rw-r--r-- 0/0 5 1985-10-26 08:15 package/package.json`;

  it('passes when the tarball keeps the executable bit', () => {
    expect(missingExecBits(listing('-rwxr-xr-x'), ['scripts/bugsee-xcode.sh'])).toEqual([]);
  });

  it('reports a file that is executable for the owner only (0744)', () => {
    expect(missingExecBits(listing('-rwxr--r--'), ['scripts/bugsee-xcode.sh'])).toEqual(['scripts/bugsee-xcode.sh']);
    expect(missingExecBits(listing('-rwxr-xr--'), ['scripts/bugsee-xcode.sh'])).toEqual(['scripts/bugsee-xcode.sh']);
  });

  it('reports a file whose executable bit was dropped, as yarn pack did', () => {
    expect(missingExecBits(listing('-rw-r--r--'), ['scripts/bugsee-xcode.sh'])).toEqual(['scripts/bugsee-xcode.sh']);
  });

  it('fails closed when the listing cannot be parsed, instead of passing vacuously', () => {
    expect(() => missingExecBits('drwxr-xr-x  0 0 0 0 Oct 26  1985 weird/format', ['scripts/bugsee-xcode.sh'])).toThrow(
      /could not read the tar listing/,
    );
    expect(() => missingExecBits('', ['scripts/bugsee-xcode.sh'])).toThrow();
  });

  it('ignores a file that is not in the tarball (the files field decides that)', () => {
    expect(missingExecBits(listing('-rw-r--r--'), ['scripts/other.sh'])).toEqual([]);
  });
});
