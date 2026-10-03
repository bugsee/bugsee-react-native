import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = join(__dirname, '..', 'check-rn-compat.sh');

function assignsHandleSource(): string {
  const src = readFileSync(scriptPath, 'utf8');
  const start = src.indexOf('assigns_handle() {');
  if (start < 0) {
    throw new Error('assigns_handle missing');
  }
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') {
      depth += 1;
    } else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error('assigns_handle unclosed');
}

function runBash(script: string, file: string): number {
  const result = spawnSync('bash', ['-c', script, 'bash', file], { encoding: 'utf8' });
  return result.status ?? 1;
}

describe('assigns_handle under pipefail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assigns-handle-'));
  const fn = assignsHandleSource();

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, body: string): string {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  }

  it('accepts an assignment at the start of a file large enough to SIGPIPE grep -q', () => {
    const file = write(
      'early-assignment.js',
      `this.__internalInstanceHandle = host;\n${'const unused = 1;\n'.repeat(80_000)}`,
    );
    const broken = `
set -euo pipefail
grep -v -E '^[[:space:]]*(//|\\*)' "$1" | grep -qE '\\.__internalInstanceHandle[[:space:]]*=([^=]|$)'
`;
    const brokenStatus = runBash(broken, file);
    expect(brokenStatus).toBeGreaterThan(0);

    const fixed = `
set -euo pipefail
${fn}
assigns_handle "$1"
`;
    expect(runBash(fixed, file)).toBe(0);
  });

  it('rejects a comparison', () => {
    const file = write('comparison.js', 'if (this.__internalInstanceHandle === null) return;\n');
    const fixed = `
set -euo pipefail
${fn}
assigns_handle "$1"
`;
    expect(runBash(fixed, file)).toBeGreaterThan(0);
  });

  it('rejects a comment that mentions the assignment', () => {
    const file = write('comment.js', '// this.__internalInstanceHandle = host;\n');
    const fixed = `
set -euo pipefail
${fn}
assigns_handle "$1"
`;
    expect(runBash(fixed, file)).toBeGreaterThan(0);
  });
});
