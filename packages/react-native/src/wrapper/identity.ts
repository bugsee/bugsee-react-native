/**
 * Who this wrapper is, as the SDKs' `BugseeWrapper` contract asks.
 *
 * Both platforms expose `wrapperType` / `wrapperVersion` / `wrapperBuild` and
 * a string-to-string `context` map. JS gathers the values because JS is where
 * they are knowable — the React Native version, the engine and the build
 * configuration are all JS-side facts — and hands them to the bridge, which
 * registers a wrapper object carrying them.
 */

/**
 * The backend's own identifier for this wrapper
 * (`APPLICATION_SUB_TYPE_REACT_NATIVE`). Note that three spellings exist:
 * the Android SDK's doc comment suggests `react-native`, and the 6.x wrapper
 * sent `react`. Symbolication routes on the exception type, not on this, so
 * the choice is about identification rather than dispatch.
 */
export const WRAPPER_TYPE = 'react_native';

export interface WrapperFacts {
  /** The `@bugsee/react-native` package version. */
  version: string;
  reactNativeVersion: string;
  /** Whether Hermes is the engine, from `global.HermesInternal`. */
  hermes: boolean;
  /** Whether this is a debug build, from `__DEV__`. */
  dev: boolean;
  build?: string;
}

export interface WrapperIdentity {
  type: string;
  version: string;
  build?: string;
  /** String-to-string, because that is how both SDKs type it. */
  context: Record<string, string>;
}

/** Reported when a fact is missing, rather than an empty string that reads
 *  as "this wrapper has no version". */
const UNKNOWN = 'unknown';

export function wrapperIdentity(facts: WrapperFacts): WrapperIdentity {
  return {
    type: WRAPPER_TYPE,
    version: facts.version || UNKNOWN,
    ...(facts.build === undefined ? {} : { build: facts.build }),
    context: {
      'react-native': facts.reactNativeVersion || UNKNOWN,
      'js-engine': facts.hermes ? 'hermes' : 'jsc',
      'build-configuration': facts.dev ? 'debug' : 'release',
    },
  };
}
