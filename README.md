# Bugsee for React Native

The Bugsee SDK for React Native: crash, error and bug reports that carry the video,
network traffic, console logs and traces that led up to them. It wraps the native
Bugsee SDKs for iOS and Android rather than reimplementing them.

**Status: beta.** The npm `latest` and `beta` tags both point at the current beta.

| Package | What it is |
|---|---|
| [`@bugsee/react-native`](packages/react-native) | The SDK. Start here: requirements, install, API, Expo config plugin and release symbolication are in its README. |
| [`@bugsee/react-native-feedback`](packages/react-native-feedback) | Optional in-app feedback chat. Same version as the SDK. |

```sh
yarn add @bugsee/react-native@beta
```

## Examples

- [`examples/playground`](examples/playground): a sample app with a button for every SDK API.
- [`examples/bare`](examples/bare) and [`examples/expo`](examples/expo): minimal apps, also used by the end-to-end suites.

## Developing

This is a Yarn 4 workspace. `yarn install`, then `yarn lint`, `yarn typecheck` and `yarn test`.
Design notes live in [`docs/design`](docs/design); the cross-platform wrapper
[workbook](docs/cross-platform-wrapper-workbook.md) explains the native contract.

## Releasing

Releases run from the manual [Release workflow](.github/workflows/release.yml), which publishes
through npm trusted publishing (no token in this repository) after the lint, typecheck and unit
gates and `scripts/check-publishable.mjs` pass. It defaults to a dry run.

## Licence

MIT. See [LICENSE](LICENSE). The native Bugsee SDKs the packages bundle are separate packages with
their own terms.
