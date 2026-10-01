import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(__dirname, '..', '..');
const android = (...p: string[]) =>
  readFileSync(join(repo, 'packages', 'react-native', 'android', ...p), 'utf8');

describe('Android keep rules for ReactNativeWebException', () => {
  it('consumer-rules.pro keeps ReactNativeWebException by name', () => {
    const rules = android('consumer-rules.pro');
    expect(rules).toContain(
      '-keepnames class com.bugsee.reactnative.ReactNativeWebException',
    );
  });

  it("the library's build.gradle declares consumer-rules.pro", () => {
    const gradle = android('build.gradle');
    expect(gradle).toMatch(/consumerProguardFiles\s+['"]consumer-rules\.pro['"]/);
  });

  it('ReactNativeWebException is a top-level class in com.bugsee.reactnative', () => {
    const src = android(
      'src',
      'main',
      'java',
      'com',
      'bugsee',
      'reactnative',
      'ReactNativeWebException.java',
    );
    expect(src).toMatch(/^package com\.bugsee\.reactnative;/m);
    // Top-level: the file declares the class, not a nested Static member of
    // another type. The backend routes on this exact FQCN.
    expect(src).toMatch(
      /(?:^|\n)(?:public\s+|final\s+|public\s+final\s+|final\s+public\s+)*class\s+ReactNativeWebException\b/,
    );
    expect(src).not.toMatch(
      /class\s+\w+\s*\{[\s\S]*class\s+ReactNativeWebException\b/,
    );
  });
});
