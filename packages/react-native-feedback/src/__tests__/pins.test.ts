import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = join(__dirname, '..', '..');
const read = (...parts: string[]) => readFileSync(join(pkg, ...parts), 'utf8');
const versions = JSON.parse(
  readFileSync(join(pkg, '..', '..', 'native-versions.json'), 'utf8'),
) as { android: { sdk: string }; ios: { sdk: string } };

describe('the feedback package pins the same native versions as the core', () => {
  const podspec = read('BugseeReactNativeFeedback.podspec');
  const manifest = read('ios', 'Package.swift');
  const gradle = read('android', 'build.gradle');
  const bridge = read(
    'android',
    'src',
    'main',
    'java',
    'com',
    'bugsee',
    'reactnative',
    'feedback',
    'FeedbackBridge.java',
  );
  const ios = read('ios', 'BugseeFeedbackModule.mm');
  const client = read('ios', 'BugseeFeedbackClient.m');

  it('reads the iOS pin from native-versions.json in the podspec', () => {
    expect(podspec).toMatch(/native\['ios'\]\['sdk'\]/);
    expect(podspec).not.toMatch(/7\.0\.0-beta1/);
  });

  it('does not depend on a Bugsee pod and does not use spm_dependency', () => {
    expect(podspec).not.toMatch(/s\.dependency\s+['"]Bugsee['"]/);
    expect(podspec).not.toMatch(/spm_dependency/);
  });

  it('fetches the feedback-spm tag, not a second copy of the core framework', () => {
    expect(podspec).toMatch(/github\.com\/bugsee\/feedback-spm/);
    expect(podspec).not.toMatch(/vendored_frameworks/);
    expect(podspec).not.toMatch(/Bugsee\.xcframework/);
  });

  it('pins feedback-spm and the core SPM package to the iOS sdk version', () => {
    const pins = [
      ...manifest.matchAll(/url:\s*"https:\/\/github\.com\/bugsee\/(?:feedback-)?spm"\s*,\s*exact:\s*"([^"]+)"/g),
    ].map((match) => match[1]);
    expect(pins).toEqual([versions.ios.sdk, versions.ios.sdk]);
  });

  it('declares bugsee-android-feedback at the core Android pin', () => {
    expect(gradle).toMatch(
      /api\s+"com\.bugsee:bugsee-android-feedback:\$\{nativeVersions\.android\.sdk\}"/,
    );
    expect(gradle).toMatch(
      /api\s+"com\.bugsee:bugsee-android:\$\{nativeVersions\.android\.sdk\}"/,
    );
    expect(versions.android.sdk).toBe('7.3.0');
  });

  it('reaches Android feedback through Bugsee.ext(Feedback.class)', () => {
    expect(bridge).toMatch(/Bugsee\.ext\(Feedback\.class\)/);
    expect(bridge).toMatch(/showFeedbackActivity\(/);
    expect(bridge).toMatch(/setDefaultFeedbackGreeting\(/);
    expect(bridge).toMatch(/setOnNewFeedbackListener\(/);
    expect(bridge).toMatch(/appearance\.setColor\(property/);
  });

  it('reaches iOS feedback through BugseeFeedback.shared', () => {
    expect(client).toMatch(/\[BugseeFeedback shared\]/);
    expect(client).toMatch(/\[BugseeFeedback register\]/);
    expect(client).toMatch(/showFeedbackUI/);
    expect(client).toMatch(/setGreeting:/);
    expect(client).toMatch(/setListener:/);
  });

  it('imports the generated Swift header for the delivery that builds it', () => {
    const corePodspec = readFileSync(
      join(pkg, '..', 'react-native', 'BugseeReactNative.podspec'),
      'utf8',
    );
    expect(ios).not.toMatch(/__has_include/);
    expect(client).not.toMatch(/__has_include/);
    // The .mm is Objective-C++ with C++ modules off, so it cannot import the
    // Swift module. The ObjC client imports the clang module, whose map
    // points at the flat BugseeFeedback-Swift.h Xcode emits.
    expect(client).toMatch(/@import BugseeFeedback;/);
    expect(client).not.toMatch(/#import <BugseeFeedback\/BugseeFeedback-Swift.h>/);
    expect(client).not.toMatch(/#import "BugseeFeedback-Swift.h"/);
    expect(client).toMatch(/#import "BugseeReactNativeFeedback-Swift.h"/);
    expect(client).toMatch(/#error "Bugsee feedback Swift header import is not configured"/);
    expect(manifest).toMatch(/BUGSEE_FEEDBACK_SPM/);
    expect(podspec).toMatch(/BUGSEE_FEEDBACK_COCOAPODS=1/);
    expect(podspec).toMatch(/private_header_files = 'ios\/\*\*\/\*\.h'/);
    expect(corePodspec).toMatch(/'DEFINES_MODULE' => 'YES'/);
  });

  it('guards codegen emits and nils the SDK listener only for its own relay', () => {
    expect(ios).toMatch(/catch \(const std::exception &e\)/);
    expect(client).toMatch(/_relay\.module = nil/);
    expect(client).toMatch(/if \(InstalledFeedbackRelay != relay\)/);
    expect(client).toMatch(/setListener:nil/);
    expect(bridge).toMatch(/clearListener/);
    expect(bridge).toMatch(/if \(installedListener != expected\)/);
    expect(bridge).not.toMatch(/JSONObject\.NULL/);
  });
});
