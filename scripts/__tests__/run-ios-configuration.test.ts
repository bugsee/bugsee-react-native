import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scriptPath = join(__dirname, '..', '..', 'examples', 'bare', 'scripts', 'run-ios.sh');
const script = readFileSync(scriptPath, 'utf8');

/** Drop shell comments so prose about Debug is not read as the rule. */
function code(source: string): string {
  return source
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
}

describe('run-ios.sh IOS_CONFIGURATION', () => {
  it('the embed check follows IOS_CONFIGURATION', () => {
    const body = code(script);
    expect(body).toMatch(/CONFIGURATION="\$\{IOS_CONFIGURATION:-Debug\}"/);
    expect(body).toMatch(
      /APP="ios\/build\/Build\/Products\/\$\{CONFIGURATION\}-iphoneos\/BareExample\.app"/,
    );
    expect(body).toMatch(/-configuration "\$CONFIGURATION"/);
    // The embed assertion must receive that same APP, not a hard-coded Debug path.
    expect(body).toMatch(/cli-assert-framework-embedded\.ts "\$APP"/);
    expect(body).not.toMatch(/APP="ios\/build\/Build\/Products\/Debug-iphoneos/);
  });
});
