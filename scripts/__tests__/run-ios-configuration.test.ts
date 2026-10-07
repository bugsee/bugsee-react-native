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
    // The app path is built from the configuration and the SDK, and the SDK
    // is iphoneos unless IOS_TARGET=simulator (N-27 switches).
    expect(body).toMatch(
      /APP="\$APP_DIR\/\$BUILD_DIR\/Build\/Products\/\$\{CONFIGURATION\}-\$\{SDK\}\/\$\{SCHEME\}\.app"/,
    );
    expect(body).toMatch(/^SDK=iphoneos$/m);
    expect(body).toMatch(/\[\[ "\$TARGET" == simulator \]\] && SDK=iphonesimulator/);
    expect(body).toMatch(/^BUILD_DIR="ios\/build"$/m);
    expect(body).toMatch(/-configuration "\$CONFIGURATION"/);
    // The embed assertion must receive that same APP, not a hard-coded Debug path.
    expect(body).toMatch(/cli-assert-framework-embedded\.ts "\$APP"/);
    expect(body).not.toMatch(/Products\/Debug-iphoneos/);
  });
});
