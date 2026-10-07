import {
  type PlanItem,
  type RunRecord,
  type TestResult,
  buildRows,
  cellOf,
  csvField,
  idsOfCell,
  outcomeOf,
  parseCsv,
  parseJestJson,
  parseManualCsv,
  parsePlan,
  proofMatches,
  redact,
  renderCsv,
  renderMarkdown,
  runPathParts,
  suiteOf,
  verdictOf,
} from '../campaign-evidence';

/** Campaign N-26: run results into the plan's section 4.2 table. */

describe('idsOfCell', () => {
  it.each([
    ['API-01a', ['API-01a']],
    ['OPT-ACC-01', ['OPT-ACC-01']],
    ['S-1', ['S-1']],
    ['API-15b-d', ['API-15b-d']],
    ['G0-1', ['G0-1']],
    ['MX-RN-81 .. MX-RN-83 (3 rows)', ['MX-RN-81', 'MX-RN-82', 'MX-RN-83']],
    ['MX-EXPO-54/55/57', ['MX-EXPO-54', 'MX-EXPO-55', 'MX-EXPO-57']],
    ['MX-16KB', ['MX-16KB']],
    ['ID', []],
    ['---', []],
    ['api-01', []],
    ['', []],
  ])('%p names %p', (cell, ids) => {
    expect(idsOfCell(cell)).toEqual(ids);
  });
});

const PLAN = `# plan
| ID | Check | Proof |
|---|---|---|
| X-0 | before scope | \`launch > ignored\` |

### 0.4 Precondition checklist
| ID | Check | Proof |
|---|---|---|
| G0-1 | CI green | GitHub checks |

## 1. Checklist
| ID | Item | Expected A | Proof (targets) |
|---|---|---|---|
| API-10 | \`testJsCrash()\` | crash | \`js-crash > is reported as one crash: the JS error, unhandled\` (A x5) |
| API-06 | listeners | events | \`lifecycle > onLifecycleEvent sees launch, the report assembled...\`, \`blackout\` |
| MX-RN-81 .. MX-RN-82 (2 rows) | generated apps | smoke | builds |
not a row | API-99 | x |

## 2. Lanes
| API-77 | after scope | \`launch > x\` |
`;

describe('parsePlan', () => {
  it('reads the ID rows from section 0.4 through section 1, with their suite > title proofs', () => {
    expect(parsePlan(PLAN)).toEqual([
      { id: 'G0-1', item: 'CI green', proofs: [] },
      { id: 'API-10', item: '`testJsCrash()`', proofs: ['js-crash > is reported as one crash: the JS error, unhandled'] },
      { id: 'API-06', item: 'listeners', proofs: ['lifecycle > onLifecycleEvent sees launch, the report assembled...'] },
      { id: 'MX-RN-81', item: 'generated apps', proofs: [] },
      { id: 'MX-RN-82', item: 'generated apps', proofs: [] },
    ]);
  });

  it('accepts CRLF and a ### 0.4 heading', () => {
    expect(parsePlan(PLAN.replace(/\n/g, '\r\n')).map(item => item.id)).toEqual(['G0-1', 'API-10', 'API-06', 'MX-RN-81', 'MX-RN-82']);
  });

  it('reads nothing without a 0.4 section', () => {
    expect(parsePlan('| API-10 | x | `js-crash > y` |')).toEqual([]);
  });
});

describe('runPathParts and suiteOf', () => {
  it('reads lane, target and name', () => {
    expect(runPathParts('sa/A/smoke-r1-20261007T101010Z.json')).toEqual({ lane: 'sa', target: 'A', name: 'smoke-r1-20261007T101010Z' });
    expect(runPathParts('xs\\X\\MX-RN-83-smoke-r2-1.json')).toEqual({ lane: 'xs', target: 'X', name: 'MX-RN-83-smoke-r2-1' });
    expect(runPathParts('stg/STG/s-r1.json')?.target).toBe('STG');
  });

  it.each([['sa/Q/x.json'], ['sa/A/x.log'], ['A/x.json'], ['a/b/A/x.json'], ['sa/A/x.failing.jsonl']])('%p is not a run', path => {
    expect(runPathParts(path)).toBeUndefined();
  });

  it('names the suite from the test file', () => {
    expect(suiteOf('/x/e2e/js-crash.test.ts')).toBe('js-crash');
    expect(suiteOf('C:\\x\\e2e\\launch.test.tsx')).toBe('launch');
    expect(suiteOf('smoke.test.js')).toBe('smoke');
  });
});

const JEST = JSON.stringify({
  testResults: [
    {
      testFilePath: '/r/examples/bare/e2e/js-crash.test.ts',
      assertionResults: [
        { fullName: 'testJsCrash() on an Android handset is reported as one crash: the JS error, unhandled', title: 'is reported as one crash: the JS error, unhandled', status: 'passed' },
        { fullName: 'testJsCrash() on an Android handset is filed at the default crash priority', title: 'is filed at the default crash priority', status: 'failed' },
        { fullName: 'x skipped one', title: 'skipped one', status: 'pending' },
      ],
    },
    { name: '/r/e2e/smoke.test.ts' },
  ],
});

describe('parseJestJson', () => {
  it('reads each assertion, with the it.failing flag from the sidecar', () => {
    const sidecar = [
      JSON.stringify({ fullName: 'testJsCrash() on an Android handset is filed at the default crash priority', failing: true }),
      '',
      JSON.stringify({ fullName: 'other', failing: false }),
    ].join('\n');
    expect(parseJestJson(JEST, sidecar)).toEqual([
      { suite: 'js-crash', fullName: 'testJsCrash() on an Android handset is reported as one crash: the JS error, unhandled', title: 'is reported as one crash: the JS error, unhandled', status: 'passed', failing: false },
      { suite: 'js-crash', fullName: 'testJsCrash() on an Android handset is filed at the default crash priority', title: 'is filed at the default crash priority', status: 'failed', failing: true },
      { suite: 'js-crash', fullName: 'x skipped one', title: 'skipped one', status: 'skipped', failing: false },
    ]);
  });

  it('tolerates missing fields', () => {
    expect(parseJestJson(JSON.stringify({ testResults: [{ assertionResults: [{}] }] }))).toEqual([
      { suite: '', fullName: '', title: '', status: 'skipped', failing: false },
    ]);
    expect(parseJestJson('{}')).toEqual([]);
  });
});

function test(suite: string, title: string, status: TestResult['status'] = 'passed', failing = false, prefix = 'd'): TestResult {
  return { suite, title, fullName: `${prefix} ${title}`, status, failing };
}

describe('proofMatches', () => {
  it('matches suite and exact title, or a fullName ending in it', () => {
    expect(proofMatches('launch > reaches Launched', test('launch', 'reaches Launched'))).toBe(true);
    expect(proofMatches('launch > reaches Launched', test('lifecycle', 'reaches Launched'))).toBe(false);
    expect(proofMatches('launch > reaches', test('launch', 'reaches Launched'))).toBe(false);
    expect(proofMatches('launch > outer reaches Launched', { ...test('launch', 'reaches Launched'), fullName: 'x outer reaches Launched' })).toBe(true);
    expect(proofMatches('launch > whole', { ...test('launch', 'other'), fullName: 'whole' })).toBe(true);
  });

  it('a title ending in ... matches as a prefix of the title or inside the full name', () => {
    expect(proofMatches('lifecycle > onLifecycleEvent sees...', test('lifecycle', 'onLifecycleEvent sees launch'))).toBe(true);
    expect(proofMatches('lifecycle > inner part...', { ...test('lifecycle', 'zzz'), fullName: 'a inner part b' })).toBe(true);
    expect(proofMatches('lifecycle > nope...', test('lifecycle', 'onLifecycleEvent'))).toBe(false);
  });

  it('a proof without " > " matches nothing', () => {
    expect(proofMatches('launch', test('launch', 'launch'))).toBe(false);
  });
});

const ITEM: PlanItem = { id: 'API-10', item: 'testJsCrash', proofs: ['js-crash > is one crash'] };

function run(target: RunRecord['target'], tests: TestResult[], name = 'js-crash-r1-t'): RunRecord {
  return { lane: 'l', target, name, path: `l/${target}/${name}.log`, tests };
}

describe('outcomeOf', () => {
  it('passes when every counted test passed', () => {
    expect(outcomeOf(ITEM, run('A', [test('js-crash', 'is one crash'), test('js-crash', 'other', 'failed')]))).toBe('pass');
  });

  it('fails when any counted test failed', () => {
    expect(outcomeOf(ITEM, run('A', [test('js-crash', 'is one crash', 'failed')]))).toBe('fail');
  });

  it('a passed it.failing test is the known bug still failing', () => {
    expect(outcomeOf(ITEM, run('A', [test('js-crash', 'is one crash', 'passed', true)]))).toBe('known');
  });

  it('a failed it.failing test (the bug got fixed) fails', () => {
    expect(outcomeOf(ITEM, run('A', [test('js-crash', 'is one crash', 'failed', true)]))).toBe('fail');
  });

  it('counts a test tagged [ID] in its name', () => {
    expect(outcomeOf(ITEM, run('S', [test('n08', '[API-10] tagged', 'failed')]))).toBe('fail');
    expect(outcomeOf(ITEM, run('S', [test('n08', '[API-100] other', 'failed')]))).toBeUndefined();
  });

  it('counts every test of a run filed under the ID', () => {
    const tests = [test('smoke', 'S1 a'), test('smoke', 'S2 b', 'failed')];
    expect(outcomeOf({ id: 'MX-RN-83', item: '', proofs: [] }, run('A', tests, 'MX-RN-83-smoke-r1-t'))).toBe('fail');
    expect(outcomeOf({ id: 'MX-RN-83', item: '', proofs: [] }, run('A', tests, 'MX-RN-83'))).toBe('fail');
    expect(outcomeOf({ id: 'MX-RN-8', item: '', proofs: [] }, run('A', tests, 'MX-RN-83-smoke-r1-t'))).toBeUndefined();
  });

  it('says nothing when every counted test was skipped, or none counts', () => {
    expect(outcomeOf(ITEM, run('A', [test('js-crash', 'is one crash', 'skipped')]))).toBeUndefined();
    expect(outcomeOf(ITEM, run('A', [test('launch', 'x')]))).toBeUndefined();
  });
});

describe('cellOf and verdictOf', () => {
  it.each([
    [[], '-'],
    [['pass', 'pass'], 'PASS 2/2'],
    [['fail'], 'FAIL 1/1'],
    [['fail', 'fail', 'fail'], 'FAIL 3/3'],
    [['pass', 'fail', 'pass'], 'FLAKY 2/3'],
    [['known', 'known'], 'FAIL 2/2 (known)'],
    [['known'], 'FAIL 1/1 (known)'],
    [['known', 'fail'], 'FAIL 2/2'],
    [['fail', 'known', 'known'], 'FAIL 3/3'],
    [['known', 'pass'], 'FLAKY 1/2'],
    [['known', 'pass', 'fail'], 'FLAKY 1/3'],
  ] as const)('%p -> %p', (outcomes, cell) => {
    expect(cellOf(outcomes)).toBe(cell);
  });

  it.each([
    [['PASS 2/2', '-', 'N/A (no crash reporter)'], 'PASS'],
    [['PASS 2/2', 'FLAKY 1/2'], 'FLAKY'],
    [['FLAKY 1/2', 'FAIL 2/2'], 'FAIL'],
    [['FAIL 2/2 (known)', 'PASS 2/2'], 'FAIL (known)'],
    [['FAIL 2/2 (known)', 'FAIL 1/1'], 'FAIL'],
    [['FAIL 1/1', 'FAIL 2/2 (known)'], 'FAIL'],
    [['FAIL 2/2 (known)', 'FLAKY 1/2'], 'FAIL (known)'],
    [['BLOCKED (worker)', 'PASS 1/1'], 'BLOCKED'],
    [['BLOCKED (x)', 'FLAKY 1/2'], 'FLAKY'],
    [['N/A (x)', '-'], 'N/A'],
    [['-', '-'], 'NOT RUN'],
    [[], 'NOT RUN'],
  ])('%p -> %p', (cells, verdict) => {
    expect(verdictOf(cells)).toBe(verdict);
  });
});

describe('manual cells and CSV', () => {
  it('parses quoted fields, escaped quotes, CRLF and a trailing line without newline', () => {
    expect(parseCsv('a,"b,c","d ""q"""\r\ne,f\ng')).toEqual([['a', 'b,c', 'd "q"'], ['e', 'f'], ['g']]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,\n')).toEqual([['a', '']]);
  });

  it('reads manual cells, skipping the header and blank lines', () => {
    expect(parseManualCsv('id,target,cell,evidence\nAPI-38,A,PASS 1/1,"M-A1, user tapped"\n\nS-1,STG,BLOCKED (worker),ART-107\n')).toEqual([
      { id: 'API-38', target: 'A', cell: 'PASS 1/1', evidence: 'M-A1, user tapped' },
      { id: 'S-1', target: 'STG', cell: 'BLOCKED (worker)', evidence: 'ART-107' },
    ]);
    expect(parseManualCsv('id,target,cell,evidence\nX-1,S,PASS 1/1')).toEqual([{ id: 'X-1', target: 'S', cell: 'PASS 1/1', evidence: '' }]);
  });

  it('refuses an unknown target', () => {
    expect(() => parseManualCsv('h\nAPI-1,Z,PASS,x\n')).toThrow('manual cells: unknown target "Z" for API-1');
  });

  it('quotes a CSV field only when it must', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "x"')).toBe('"say ""x"""');
    expect(csvField('a\nb')).toBe('"a\nb"');
  });
});

describe('buildRows and rendering', () => {
  const items: PlanItem[] = [ITEM, { id: 'API-38', item: 'dialog Send', proofs: [] }];
  const runs = [
    run('A', [test('js-crash', 'is one crash')], 'js-crash-r1-a'),
    run('A', [test('js-crash', 'is one crash')], 'js-crash-r2-a'),
    run('A', [test('js-crash', 'is one crash')], 'js-crash-r3-a'),
    run('A', [test('js-crash', 'is one crash')], 'js-crash-r4-a'),
    run('X', [test('js-crash', 'is one crash', 'failed')], 'js-crash-r1-x'),
    run('S', [test('js-crash', 'is one crash', 'skipped')], 'js-crash-r1-s'),
  ];

  it('computes each target cell, the verdict and the evidence paths', () => {
    const rows = buildRows(items, runs, [{ id: 'API-38', target: 'A', cell: 'PASS 1/1', evidence: 'M-A1' }]);
    expect(rows[0]).toEqual({
      id: 'API-10',
      item: 'testJsCrash',
      cells: { A: 'PASS 4/4', S: '-', X: 'FAIL 1/1', B: '-', STG: '-' },
      verdict: 'FAIL',
      evidence: 'A: l/A/js-crash-r1-a.log, l/A/js-crash-r2-a.log, l/A/js-crash-r3-a.log (+1); X: l/X/js-crash-r1-x.log',
    });
    expect(rows[1]).toEqual({
      id: 'API-38',
      item: 'dialog Send',
      cells: { A: 'PASS 1/1', S: '-', X: '-', B: '-', STG: '-' },
      verdict: 'PASS',
      evidence: 'A: M-A1',
    });
  });

  it('a manual cell with no evidence adds no note', () => {
    expect(buildRows([items[1]!], [], [{ id: 'API-38', target: 'B', cell: 'N/A (x)', evidence: '' }])[0]!.evidence).toBe('');
  });

  it('renders Markdown and CSV, escaping pipes, and redacts every secret', () => {
    const secret = '1f2e3d4c-5b6a-4789-8abc-def012345678';
    const rows = buildRows([{ id: 'API-1', item: `a | b ${secret}`, proofs: [] }], [], [
      { id: 'API-1', target: 'STG', cell: 'PASS 1/1', evidence: `token ${secret}\nline` },
    ]);
    const md = renderMarkdown(rows, ['Campaign SHA: abc'], [secret, 'short']);
    expect(md).toContain('- Campaign SHA: abc');
    expect(md).toContain('| ID | Item | A (WOD_LX1) | S (sim) | X (XS) | B | STG | Verdict | Evidence / notes |');
    expect(md).toContain('| API-1 | a \\| b [redacted] | - | - | - | - | PASS 1/1 | PASS | STG: token [redacted] line |');
    expect(md).not.toContain(secret);
    const csv = renderCsv(rows, [secret]);
    expect(csv.split('\n')[0]).toBe('id,item,A,S,X,B,STG,verdict,evidence');
    expect(csv).toContain('API-1,a | b [redacted],-,-,-,-,PASS 1/1,PASS,"STG: token [redacted]\nline"');
    expect(csv).not.toContain(secret);
  });

  it('redact leaves short strings alone', () => {
    expect(redact('abc 1234567 12345678', ['1234567', '12345678'])).toBe('abc 1234567 [redacted]');
  });
});

describe('plan parsing, at its edges', () => {
  it('trims a cell, accepts a range with or without spaces, and anchors at the start', () => {
    expect(idsOfCell('  API-01a  ')).toEqual(['API-01a']);
    expect(idsOfCell('MX-RN-81..MX-RN-82')).toEqual(['MX-RN-81', 'MX-RN-82']);
    expect(idsOfCell('MX-RN-81 ..MX-RN-82')).toEqual(['MX-RN-81', 'MX-RN-82']);
    expect(idsOfCell('MX-RN-81.. MX-RN-82')).toEqual(['MX-RN-81', 'MX-RN-82']);
    expect(idsOfCell('see MX-RN-81 .. MX-RN-82')).toEqual([]);
    expect(idsOfCell('see MX-EXPO-54/55')).toEqual([]);
    expect(idsOfCell('MX-RN-81 .. MX-EXPO-82')).toEqual(['MX-RN-81']);
  });

  it('reads a row with spacing around its pipes, but not a heading that only mentions a section', () => {
    const plan = [
      'intro ## 2. not a heading',
      '### 0.4 Gate',
      '   |  G0-2  |  local tests  |  logs |  ',
      'text | G0-9 | not a row |',
      '| G0-3 | trailing pipe text |extra',
      'see ## 2. inline',
      '| G0-4 | still in scope | x |',
      '#### 0.4 too deep',
      '## 2. Lanes',
      '| G0-5 | out | x |',
    ].join('\n');
    expect(parsePlan(plan)).toEqual([
      { id: 'G0-2', item: 'local tests', proofs: [] },
      { id: 'G0-3', item: 'trailing pipe text', proofs: [] },
      { id: 'G0-4', item: 'still in scope', proofs: [] },
    ]);
  });

  it('a proof needs a suite, " > " and a title', () => {
    const plan = '### 0.4 x\n| API-1 | i | `a > b`, `> b`, `a >b`, `a b`, `a-b > c d` |\n';
    expect(parsePlan(plan)[0]!.proofs).toEqual(['a > b', 'a-b > c d']);
  });
});
