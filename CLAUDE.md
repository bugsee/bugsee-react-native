# Bugsee React Native SDK

Monorepo (yarn 4 workspaces, Node scripts in TypeScript run by Node's type stripping) for the Bugsee React Native SDK. It wraps the native Bugsee SDKs: **Android** (Maven Central `com.bugsee:bugsee-android`) and **iOS** (Swift Package Manager, `https://github.com/bugsee/spm`, SPM only). The repo is `bugsee/bugsee-react-native`.

## Layout

| Path | What it is |
| --- | --- |
| `packages/react-native` | `@bugsee/react-native`: JS API (`src/`), Android bridge (`android/`), iOS bridge (`ios/`, SPM package in `ios/Support`), Expo config plugin (`plugin/`), install scripts (`scripts/`), README |
| `packages/react-native-feedback` | `@bugsee/react-native-feedback`: the feedback client, released at the same version as the main package |
| `src/options/` (in `react-native`) | Launch options: accessor classes (`BugseeLaunchOptions` shared, `IOSLaunchOptions`, `AndroidLaunchOptions`), `keys.ts`, `option-keys.json`, `option-enums.json`, `ios-enums.json`, and the two committed manifests `ios-options-manifest.json` / `android-options-manifest.json` |
| `native-versions.json` | **The pins**: Android SDK, Bugsee Gradle plugin, iOS SDK, SPM URL. The baked copy is `packages/react-native/plugin/build/native-versions.baked.json` |
| `scripts/` | Repo tooling and release gates (`cli-*.ts` are entry points; the logic sits beside them and is unit-tested in `scripts/__tests__`) |
| `docs/` | `release-notes.md`, `launch-options.md` (generated), `design/` (design doc and implementation plan), `ci/`, `cross-platform-wrapper-workbook.md` |
| `examples/bare` | Bare RN app and the Detox-less e2e suite (`e2e/`, `scenarios/`); also `expo`, `playground`, `e2e-native` |
| `.github/workflows` | `ci.yml`, `release.yml` (manual, npm trusted publishing), `mutation-gate.yml`, `claude-review.yml`, ... |

## Commands

- `yarn lint` (eslint plus `check-no-internal-hosts`), `yarn typecheck`, `yarn test` (jest, no network allowed).
- `yarn check:options-manifests` compares the pinned SDKs' published option manifests with this package (needs network).
- `yarn check:publishable`, `yarn test:release`: the release gates. `prepack` runs `scripts/cli-check-releasable-pins.ts`, which refuses SNAPSHOT pins and unresolved SPM placeholders.
- e2e: from `examples/bare`, `E2E_PLATFORM=android ANDROID_SERIAL=<serial> yarn e2e '<pattern>'`. Placeholder tokens and `BUGSEE_ENDPOINT=http://127.0.0.1:9` are enough; start Metro with `yarn start` and `adb reverse tcp:8081 tcp:8081`.
- Releases: run the `release.yml` workflow (`-f tag=beta -f also_tag=latest -f dry_run=false`). It runs the gates, publishes both packages, then tags and creates the GitHub release. The npm `latest` tag follows `beta` for now (documented in the README).

## Updating the underlying SDKs

Do this when Bugsee Android, Bugsee iOS or the Bugsee Gradle plugin publishes a new version. Check each against its registry: Android on Maven Central (`maven-metadata.xml` of `com/bugsee/bugsee-android`), the Gradle plugin on Maven Central (`com/bugsee/android/gradle/com.bugsee.android.gradle.gradle.plugin`, not the Plugin Portal), iOS from the `bugsee/spm` tags. Always pin the **latest** published version, exactly (no ranges, no SNAPSHOT).

### 1. Bump the pins

- `native-versions.json` (`android.sdk`, `android.gradlePlugin`, `ios.sdk`) and its baked copy `packages/react-native/plugin/build/native-versions.baked.json`.
- iOS only: `exact:` in `packages/react-native/ios/Support/Package.swift` and `packages/react-native-feedback/ios/Package.swift`, and `packages/react-native/ios/Support/Package.resolved` (revision and version of `bugsee/spm`).
- Gradle plugin only: `examples/bare/android/build.gradle` (the plugin `version` **and** the `applied` guard), the README snippet in `packages/react-native/README.md`, and the `scripts/check-expo-prebuild.sh` / `plugin/src/gradle.ts` comments that name the version.
- Tests that assert the pin: `scripts/__tests__/native-versions.test.ts`, `scripts/__tests__/github-release.test.ts`, `packages/react-native-feedback/src/__tests__/pins.test.ts`.
- Text that names the versions: `README.md` (beta line), `docs/launch-options.md` (header), and the version bullets in `docs/design/2026-09-15-sdk-design.md` and `docs/design/plans/2026-09-16-implementation-plan.md`. The `docs-versions` test fails if the design doc or plan do not name the pinned Android SDK, Gradle plugin and iOS SDK.
- Historical text ("added in 7.5.0", old release-note sections) stays as written; only change what describes the current pin.

### 2. Adopt the launch options (golden files)

Each native SDK's build and deploy job publishes an **options manifest** for every release to our CDN. It is the **golden file**: immutable and fixed, it never changes for a published version. Any Bugsee SDK that embeds a native SDK must consult it and adopt the option changes. The URL is

`https://download.bugsee.com/sdk/options/<android|ios>/<version>.json`

(override the base with `BUGSEE_OPTIONS_MANIFEST_BASE`). Each lists every option the SDK registers: key, type, default, hidden flag, deprecation, enum constants.

How this repo reads and checks it:

- `yarn check:options-manifests` (`scripts/cli-check-published-manifests.ts`) fetches the golden file of the **pinned** version of each platform (retrying; an unreachable manifest fails the check) and reports, by option name: options the SDK has that `option-keys.json` does not list; committed manifest copies that differ from the published options in type, default, hidden flag, deprecation or enum constants; published options with no accessor (or one whose setter or type cannot hold the SDK's value); missing enum constants; and any difference between `docs/launch-options.md` and the generator output. It is deliberately one-directional: options only this package has are fine.
- `--dir <directory>` reads `<directory>/<platform>/<version>.json` for offline work.

To adopt a new version:

1. Run `yarn check:options-manifests` after the pin bump and read the report.
2. iOS: `yarn check:options-manifests --update` writes the published manifest over `ios-options-manifest.json`.
3. Android: the committed manifest and `option-keys.json` are generated by `scripts/cli-extract-option-keys.ts <iosRoot> <androidRoot>` from SDK source checkouts at **exactly the pinned versions** (it refuses another version). Use clean worktrees of the release tags; never a development tree, which would bless options the release drops. A release with only a version change leaves just `sdkVersion` different.
4. For each new, changed or removed option: add or adjust the accessor (shared options in `BugseeLaunchOptions.ts`, platform ones in `IOSLaunchOptions.ts` / `AndroidLaunchOptions.ts`) with JSDoc that states the **default** and the version that introduced or changed it; add enum constants (`option-enums.json`, `ios-enums.json`); update `__tests__/accessors.test.ts`.
5. Regenerate `docs/launch-options.md` with `scripts/cli-generate-launch-options-doc.ts` (its Notes column is the accessor JSDoc; CI checks it). Stale "default is on" text is the usual finding when a default flips.
6. If a default changed, update the e2e readback fixtures in `examples/bare/scenarios/api-constants.ts`, the README examples, and describe the change in the release notes.
7. Run `yarn lint && yarn typecheck && yarn test` and the relevant e2e against a real sample app.

### 3. Release notes and version

- Add a section to `docs/release-notes.md` (newest first): native SDK versions, behaviour changes users can see. Describe behaviour only; do not name internal APIs or classes.
- A release bumps both `package.json` versions, the feedback peer range, `BGSRNWrapper.m` and `BGSRNWrapperTests.m` (wrapper version), `plugin/src/index.ts` and `plugin/build/index.js`, `yarn.lock`, and the README beta line. Search for the old version string afterwards; comments describing past behaviour stay.
- The public docs site (`bugsee/docs`, Docusaurus) is a separate repo: `docs/sdk/react_native/*` and the Android/iOS release notes. Update it in its own PR (its CI runs cspell and a build; it needs a human approval).

### Gotchas

- A Gradle plugin bump may raise AGP / Gradle floors; read its release notes and the README before pinning.
- `scripts/__tests__/pack-lock.test.ts` is occasionally flaky; re-run before assuming a real failure.
- Do not hand-edit generated files (`docs/launch-options.md`, the Android manifest, `option-keys.json`).
