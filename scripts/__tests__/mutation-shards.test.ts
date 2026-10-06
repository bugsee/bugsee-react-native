import {
  ALL_GATES_TRIGGERS,
  GATE_INPUTS,
  countMutants,
  gatesForChanges,
  globPrefix,
  mergeReports,
  mutantGroups,
  planShards,
} from '../mutation-shards';
import type { FileMutants, GateScope, MutationReport } from '../mutation-shards';

const span = (startLine: number, endLine = startLine) => ({ startLine, endLine });

/** Mirrors Stryker's rule: a mutant is placed only when a range holds all of it. */
function placedBy(shardMutate: readonly string[], file: FileMutants): number {
  return file.spans.filter((s) =>
    shardMutate.some((entry) => {
      if (entry === file.name) return true;
      const match = /^(.*):(\d+)-(\d+)$/.exec(entry);
      return match !== null && match[1] === file.name && Number(match[2]) <= s.startLine && s.endLine <= Number(match[3]);
    }),
  ).length;
}

describe('mutantGroups', () => {
  it('keeps mutants apart when a line between them is free to cut on', () => {
    expect(mutantGroups([span(3), span(5, 6)])).toEqual([
      { startLine: 3, endLine: 3, mutants: 1 },
      { startLine: 5, endLine: 6, mutants: 1 },
    ]);
  });

  it('joins a mutant that starts on the line another ends on', () => {
    expect(mutantGroups([span(3, 5), span(5, 7)])).toEqual([{ startLine: 3, endLine: 7, mutants: 2 }]);
  });

  it('keeps adjacent lines apart, since a cut between them splits nothing', () => {
    expect(mutantGroups([span(3, 5), span(6, 7)])).toHaveLength(2);
  });

  it('swallows everything inside a block mutant, whatever order they come in', () => {
    expect(mutantGroups([span(12), span(10, 20), span(15, 16), span(22)])).toEqual([
      { startLine: 10, endLine: 20, mutants: 3 },
      { startLine: 22, endLine: 22, mutants: 1 },
    ]);
  });

  it('keeps the furthest end when a later mutant ends earlier', () => {
    expect(mutantGroups([span(1, 10), span(2, 3), span(10, 11)])).toEqual([
      { startLine: 1, endLine: 11, mutants: 3 },
    ]);
  });

  it('orders by end when two mutants start on the same line', () => {
    expect(mutantGroups([span(4, 9), span(4, 4), span(11)])).toEqual([
      { startLine: 4, endLine: 9, mutants: 2 },
      { startLine: 11, endLine: 11, mutants: 1 },
    ]);
  });

  it('has no groups for a file without mutants', () => {
    expect(mutantGroups([])).toEqual([]);
  });
});

describe('planShards', () => {
  const big: FileMutants = {
    name: 'src/big.ts',
    lineCount: 100,
    spans: [span(5), span(6), span(10, 30), span(12), span(40), span(41), span(60), span(61), span(80, 90)],
  };
  const small: FileMutants = { name: 'src/a.ts', lineCount: 10, spans: [span(2), span(3)] };
  const empty: FileMutants = { name: 'src/types.ts', lineCount: 40, spans: [] };

  it('is the whole gate, file by file, for a single shard', () => {
    expect(planShards([big, small, empty], 1)).toEqual([{ mutate: ['src/a.ts', 'src/big.ts'], mutants: 11 }]);
  });

  it('splits a big file on safe lines, with ranges that meet end to end', () => {
    const shards = planShards([big], 3);
    expect(shards).toEqual([
      { mutate: ['src/big.ts:1-30'], mutants: 4 },
      { mutate: ['src/big.ts:31-60'], mutants: 3 },
      { mutate: ['src/big.ts:61-100'], mutants: 2 },
    ]);
  });

  it('never drops or duplicates a mutant, whatever the shard count', () => {
    const files = [big, small, empty, { name: 'src/z.ts', lineCount: 5, spans: [span(1, 5)] }];
    const total = files.reduce((sum, f) => sum + f.spans.length, 0);
    for (let n = 1; n <= 8; n += 1) {
      const shards = planShards(files, n);
      expect(shards).toHaveLength(n);
      expect(shards.reduce((sum, s) => sum + s.mutants, 0)).toBe(total);
      const placed = shards.reduce((sum, s) => sum + files.reduce((acc, f) => acc + placedBy(s.mutate, f), 0), 0);
      expect(placed).toBe(total);
      for (const s of shards) expect(s.mutants).toBeGreaterThan(0);
    }
  });

  it('balances by mutant count rather than by file', () => {
    const files: FileMutants[] = [
      { name: 'a.ts', lineCount: 50, spans: Array.from({ length: 30 }, (_, i) => span(i + 1)) },
      { name: 'b.ts', lineCount: 5, spans: [span(1), span(2)] },
      { name: 'c.ts', lineCount: 5, spans: [span(1), span(2), span(3), span(4)] },
    ];
    expect(planShards(files, 2)).toEqual([
      { mutate: ['a.ts:1-18'], mutants: 18 },
      { mutate: ['a.ts:19-50', 'b.ts', 'c.ts'], mutants: 18 },
    ]);
  });

  it('gives a middle slice its own range, starting after the previous group', () => {
    const file: FileMutants = { name: 'm.ts', lineCount: 30, spans: [span(2), span(10), span(20)] };
    expect(planShards([file], 3).map((s) => s.mutate)).toEqual([['m.ts:1-2'], ['m.ts:3-10'], ['m.ts:11-30']]);
  });

  it('fills every shard even when the cap would let the first take more', () => {
    const file: FileMutants = { name: 'x.ts', lineCount: 4, spans: [span(1), span(2), span(3, 4), span(3, 3)] };
    expect(planShards([file], 3)).toEqual([
      { mutate: ['x.ts:1-1'], mutants: 1 },
      { mutate: ['x.ts:2-2'], mutants: 1 },
      { mutate: ['x.ts:3-4'], mutants: 2 },
    ]);
  });

  it('orders files by name, so every job computes the same plan', () => {
    const a = { name: 'a.ts', lineCount: 1, spans: [span(1)] };
    const b = { name: 'b.ts', lineCount: 1, spans: [span(1)] };
    expect(planShards([b, a], 2)).toEqual(planShards([a, b], 2));
    expect(planShards([b, a], 2)[0]).toEqual({ mutate: ['a.ts'], mutants: 1 });
  });

  it('refuses more shards than there are places to cut', () => {
    expect(() => planShards([{ name: 'one.ts', lineCount: 9, spans: [span(1, 9), span(2)] }], 2)).toThrow(
      'cannot cut 1 indivisible mutant group(s) into 2 shards; use fewer shards',
    );
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a shard count of %p', (n) => {
    expect(() => planShards([small], n)).toThrow(`shard count must be a positive integer, got ${n}`);
  });
});

describe('mergeReports', () => {
  const shard0: MutationReport = {
    schemaVersion: '2',
    thresholds: { high: 100, low: 95 },
    files: {
      'src/a.ts': { language: 'typescript', source: 'A', mutants: [{ id: '0', status: 'Killed', killedBy: ['1'], coveredBy: ['0', '1'] }] },
      'src/big.ts': { language: 'typescript', source: 'B', mutants: [{ id: '1', status: 'Survived', coveredBy: ['0'] }] },
    },
    testFiles: {
      't/a.test.ts': {
        source: '',
        tests: [
          { id: '0', name: 'a works' },
          { id: '1', name: 'a fails' },
        ],
      },
    },
  };
  const shard1: MutationReport = {
    schemaVersion: '2',
    files: {
      'src/big.ts': { language: 'typescript', source: 'B', mutants: [{ id: '0', status: 'Killed', killedBy: ['0'] }] },
    },
    testFiles: {
      't/a.test.ts': { source: '', tests: [{ id: '0', name: 'a fails' }] },
      't/b.test.ts': { source: '', tests: [{ id: '1', name: 'b' }] },
    },
  };

  it('puts every mutant of every shard in one report, files sliced across shards included', () => {
    const merged = mergeReports([shard0, shard1]);
    expect(countMutants(merged)).toBe(3);
    expect(merged.files['src/big.ts']!.mutants.map((m) => m.id)).toEqual(['0-1', '1-0']);
    expect(merged.files['src/a.ts']!.source).toBe('A');
    expect(merged.schemaVersion).toBe('2');
    expect(merged.thresholds).toEqual({ high: 100, low: 95 });
  });

  it('gives a test one id in every shard and rewrites killedBy and coveredBy to it', () => {
    const merged = mergeReports([shard0, shard1]);
    expect(merged.testFiles).toEqual({
      't/a.test.ts': {
        source: '',
        tests: [
          { id: '0', name: 'a works' },
          { id: '1', name: 'a fails' },
        ],
      },
      't/b.test.ts': { source: '', tests: [{ id: '2', name: 'b' }] },
    });
    expect(merged.files['src/a.ts']!.mutants[0]).toEqual({
      id: '0-0',
      status: 'Killed',
      killedBy: ['1'],
      coveredBy: ['0', '1'],
    });
    // shard1's test "0" is "a fails", merged id 1.
    expect(merged.files['src/big.ts']!.mutants[1]!.killedBy).toEqual(['1']);
    expect(merged.files['src/big.ts']!.mutants[1]).not.toHaveProperty('coveredBy');
  });

  it('keeps an id it cannot resolve, made unique to its shard', () => {
    const lonely: MutationReport = { files: { 'x.ts': { mutants: [{ id: '0', killedBy: ['7'] }] } } };
    const merged = mergeReports([shard0, lonely]);
    expect(merged.files['x.ts']!.mutants[0]!.killedBy).toEqual(['1-7']);
  });

  it('leaves testFiles out when no shard reported any', () => {
    const merged = mergeReports([{ files: { 'x.ts': { mutants: [] } } }, { files: {}, testFiles: {} }]);
    expect(merged).not.toHaveProperty('testFiles');
    expect(merged.files).toEqual({ 'x.ts': { mutants: [] } });
  });

  it('does not touch the shard reports it was given', () => {
    const before = JSON.stringify(shard0);
    mergeReports([shard0, shard1]);
    expect(JSON.stringify(shard0)).toBe(before);
  });

  it('refuses to merge nothing', () => {
    expect(() => mergeReports([])).toThrow('no shard reports to merge');
  });
});

describe('globPrefix', () => {
  it.each([
    ['packages/react-native/src/**/*.ts', 'packages/react-native/src/'],
    ['<rootDir>/scripts/__tests__/**/*.test.ts', 'scripts/__tests__/'],
    ['<rootDir>/scripts/__tests__/option-manifest-parity.test.ts', 'scripts/__tests__/option-manifest-parity.test.ts'],
    ['scripts/cli-*.ts', 'scripts/'],
    ['src/a.ts:10-20', 'src/a.ts'],
    ['src/a.ts:10:2-20:4', 'src/a.ts'],
    ['**/*.ts', ''],
    ['*.ts', ''],
    ['src/{a,b}/x.ts', 'src/'],
    ['src/file?.ts', 'src/'],
    ['src/[ab].ts', 'src/'],
  ])('%s -> %p', (glob, prefix) => {
    expect(globPrefix(glob)).toBe(prefix);
  });
});

describe('gatesForChanges', () => {
  const src: GateScope = {
    name: 'src',
    configFile: 'stryker.src.json',
    mutate: ['packages/react-native/src/**/*.ts', '!**/__tests__/**'],
    testMatch: [
      '<rootDir>/packages/react-native/src/**/__tests__/**/*.test.ts?(x)',
      '<rootDir>/scripts/__tests__/option-manifest-parity.test.ts',
    ],
  };
  const scripts: GateScope = {
    name: 'scripts',
    configFile: 'stryker.scripts.json',
    mutate: ['scripts/**/*.ts', '!scripts/cli-*.ts'],
    testMatch: ['<rootDir>/scripts/__tests__/**/*.test.ts'],
  };
  const gates = [src, scripts];

  it('selects the gate whose mutated files changed', () => {
    expect(gatesForChanges([src], ['packages/react-native/src/index.ts'])).toEqual(['src']);
    expect(gatesForChanges(gates, ['scripts/sdk-banner.ts'])).toEqual(['scripts']);
    // raw-messages-tree walks packages/, so src changes select scripts as well.
    expect(gatesForChanges(gates, ['packages/react-native/src/index.ts'])).toEqual(['src', 'scripts']);
  });

  it('selects a gate whose covering test changed, outside its mutated tree', () => {
    expect(gatesForChanges(gates, ['scripts/__tests__/option-manifest-parity.test.ts'])).toEqual(['src', 'scripts']);
    expect(gatesForChanges(gates, ['scripts/__tests__/sdk-banner.test.ts'])).toEqual(['scripts']);
  });

  it('selects a gate whose own config changed', () => {
    expect(gatesForChanges(gates, ['stryker.src.json'])).toEqual(['src']);
  });

  it('selects nothing for changes no gate reads', () => {
    expect(gatesForChanges(gates, ['LICENSE', '.github/workflows/claude.yml', 'gradlew'])).toEqual([]);
    expect(gatesForChanges(gates, [])).toEqual([]);
  });

  // The corpus the scripts parsers are scored against: a reformatted manifest
  // can let a mutant survive with every test green.
  it.each([
    'packages/react-native/android/build.gradle',
    'packages/react-native/ios/Support/Package.swift',
    'packages/react-native/ios/Support/Package.resolved',
    'packages/react-native-feedback/BugseeReactNativeFeedback.podspec',
    'packages/react-native/react-native.config.js',
    'docs/design/2026-09-15-sdk-design.md',
    'examples/bare/android/app/build.gradle',
    'gradle/libs.versions.toml',
    'settings.gradle',
    'gradle.properties',
  ])('selects scripts alone when its test corpus file %s changes', (file) => {
    expect(gatesForChanges(gates, [file])).toEqual(['scripts']);
  });

  it.each(['native-versions.json'])('selects both gates when %s, read by tests of both, changes', (file) => {
    expect(gatesForChanges(gates, [file])).toEqual(['src', 'scripts']);
  });

  it.each(['scripts/native-versions.ts', 'scripts/option-keys.ts'])(
    'selects src too when %s, imported by its parity test, changes',
    (file) => {
      expect(gatesForChanges(gates, [file])).toEqual(['src', 'scripts']);
    },
  );

  it('pins the extra inputs of each gate', () => {
    expect(GATE_INPUTS).toEqual({
      scripts: ['packages/', 'docs/', 'examples/', 'gradle/', 'native-versions.json', 'settings.gradle', 'gradle.properties'],
      src: ['native-versions.json', 'scripts/native-versions.ts', 'scripts/option-keys.ts'],
      plugin: [
        'packages/react-native/plugin/',
        'packages/react-native/scripts/',
        'packages/react-native/package.json',
        'packages/react-native/app.plugin.js',
        'native-versions.json',
      ],
    });
  });

  it.each([
    'packages/react-native/scripts/bugsee-sourcemaps.gradle',
    'packages/react-native/scripts/hermesc-preserve-js.sh',
    'packages/react-native/plugin/src/__tests__/fixtures/finish-hook-0.0.0.gradle',
    'packages/react-native/plugin/build/index.js',
    'packages/react-native/app.plugin.js',
  ])('selects plugin when %s, which its tests read, changes', (file) => {
    const plugin: GateScope = {
      name: 'plugin',
      configFile: 'stryker.plugin.json',
      mutate: ['packages/react-native/plugin/src/**/*.ts', 'packages/react-native/scripts/hermes-sourcemaps.js'],
      testMatch: ['<rootDir>/packages/react-native/plugin/src/__tests__/**/*.test.ts'],
    };
    expect(gatesForChanges([src, plugin], [file])).toEqual(['plugin']);
  });

  it('does not take an inherited property for a gate named like one', () => {
    const odd: GateScope = { name: 'constructor', configFile: 'stryker.constructor.json', mutate: ['x/a.ts'], testMatch: [] };
    expect(gatesForChanges([odd], ['packages/a.ts'])).toEqual([]);
  });

  it('does not take a sibling directory for the mutated one', () => {
    expect(gatesForChanges([src], ['packages/react-native/srcx/a.ts', 'scriptsy/a.ts'])).toEqual([]);
  });

  it.each(ALL_GATES_TRIGGERS.map((t) => (t.endsWith('/') ? `${t}releases/yarn.cjs` : t)))(
    'selects every gate when %s changes',
    (file) => {
      expect(gatesForChanges(gates, ['docs/x.md', file])).toEqual(['src', 'scripts']);
    },
  );

  it('selects a gate without its own testMatch on any change, and on none without one', () => {
    const wide: GateScope = { name: 'wide', configFile: 'stryker.wide.json', mutate: ['lib/x.ts'] };
    expect(gatesForChanges([wide], ['docs/README.md'])).toEqual(['wide']);
    expect(gatesForChanges([wide], [])).toEqual([]);
  });

  it('matches a whole-glob pattern to anything', () => {
    const any: GateScope = { name: 'any', configFile: 'stryker.any.json', mutate: ['**/*.ts'], testMatch: [] };
    expect(gatesForChanges([any], ['deep/down/file.md'])).toEqual(['any']);
  });
});
