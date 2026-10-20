/** Node --print source. Prints the CLI package.json path, or '' when missing. */
export declare const RESOLVE_BUGSEE_CLI_PACKAGE: string;
export declare function resolveNativeCliPackageSource(packageJson: string): string;
/**
 * Stops the post-action, with exit 0 and one warning, when there is no real
 * app token. `xcode post-action` registers the build and uploads dSYMs to the
 * configured endpoint, or to the CLI's own default, production, when none is
 * set; the placeholder token must reach neither. The rule is
 * `isPlaceholderToken` (properties.ts) in POSIX sh: every dash goes first, and
 * whitespace too, because the CLI trims the token before it builds the URL.
 * The character lists are spelled out: a bracket range can follow the locale.
 * Shared with the bare example's scheme (scripts/__tests__/dsym-scheme-post-action.test.ts).
 */
export declare const TOKEN_GUARD: readonly string[];
/**
 * Looks for the token in ios/.xcode.env and ios/.xcode.env.local, the files
 * the README sends a bare app's `export BUGSEE_APP_TOKEN=...` to for the
 * bundle phase. A GUI Archive does not inherit a shell, so the post-action
 * reads them itself, and only when no earlier source gave a token. The files
 * may also set NODE_BINARY; an executable one from Xcode's own environment
 * wins, as it did before the files were read here. Shared with the bare
 * example's scheme (scripts/__tests__/dsym-scheme-post-action.test.ts).
 */
export declare const ENV_FILE_TOKEN: readonly string[];
/**
 * Relays bugsee-cli output with Xcode's `error:` diagnostics turned into
 * `warning: bugsee: ...`, and returns the CLI's exit status. A failed upload
 * must never read as a build error. Post-action output is not parsed for
 * diagnostics, but every place that relays the CLI does this the same way
 * (scripts/hermes-sourcemaps.js `diagnosticSafe`, and the bare example's
 * scheme, which tests this shared text).
 */
export declare const CLI_OUTPUT_FILTER: readonly string[];
/**
 * The Archive post-action script. `bakedToken` is the plugin's iOS token,
 * written into the script so an Archive from the Xcode GUI, which does not
 * inherit a shell environment, still has one. `bakedEndpoint`, the plugin's
 * validated `endpoint` option, is exported the same way, ahead of the
 * environment and credentials.json; without it the CLI keeps its default.
 */
export declare function dsymPostActionScript(bakedToken?: string, bakedEndpoint?: string): string;
export declare const DSYM_POST_ACTION_SCRIPT: string;
