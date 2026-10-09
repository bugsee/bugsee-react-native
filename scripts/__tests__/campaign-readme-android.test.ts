// scripts/campaign/lib/readme-android.js applies the README's "Android source
// maps" snippet literally to a generated app (gen-rn-app.sh, N-20). The
// hermesCommand it copies must be the README's whole per-OS line.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = path.join(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'campaign', 'lib', 'readme-android.js');

function appWithReadme(readme: string): { app: string; gradle: string } {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'bugsee-readme-android-'));
  const pkg = path.join(app, 'node_modules', '@bugsee', 'react-native');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"@bugsee/react-native"}\n');
  fs.writeFileSync(path.join(pkg, 'README.md'), readme);
  const gradle = path.join(app, 'android', 'app', 'build.gradle');
  fs.mkdirSync(path.dirname(gradle), { recursive: true });
  fs.writeFileSync(gradle, 'apply plugin: "com.facebook.react"\n\nreact {\n    autolinkLibrariesWithApp()\n}\n');
  return { app, gradle };
}

describe('readme-android.js', () => {
  it('copies the README hermesCommand whole, with both launchers', () => {
    const readme = fs.readFileSync(path.join(REPO, 'packages', 'react-native', 'README.md'), 'utf8');
    const { app, gradle } = appWithReadme(readme);
    try {
      const result = cp.spawnSync(process.execPath, [SCRIPT, gradle], { encoding: 'utf8' });
      expect([result.status, result.stderr]).toEqual([0, '']);
      const line = fs
        .readFileSync(gradle, 'utf8')
        .split('\n')
        .find((entry: string) => /^\s*hermesCommand = /.test(entry));
      expect(line).toBe(
        '    hermesCommand = new File(new File(bugseeDir, "scripts"), System.getProperty("os.name").startsWith("Windows") ? "hermesc-preserve-js.cmd" : "hermesc-preserve-js.sh").absolutePath',
      );
    } finally {
      fs.rmSync(app, { recursive: true, force: true });
    }
  });

  it('refuses a README whose hermesCommand spans lines', () => {
    const split = [
      '## Android source maps',
      '',
      '```groovy',
      'def bugseeDir = new File(["node", "--print", "x"].execute(null, rootDir).text.trim()).getParentFile()',
      '',
      'react {',
      '    hermesCommand = new File(new File(bugseeDir, "scripts"),',
      '        cond ? "hermesc-preserve-js.cmd" : "hermesc-preserve-js.sh").absolutePath',
      '}',
      '',
      'apply from: new File(new File(bugseeDir, "scripts"), "bugsee-sourcemaps.gradle")',
      '```',
      '',
    ].join('\n');
    const { app, gradle } = appWithReadme(split);
    try {
      const result = cp.spawnSync(process.execPath, [SCRIPT, gradle], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('README hermesCommand is not one whole per-OS line');
    } finally {
      fs.rmSync(app, { recursive: true, force: true });
    }
  });
});
