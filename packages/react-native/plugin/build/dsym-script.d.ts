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
 * The Archive post-action script. `bakedToken` is the plugin's iOS token,
 * written into the script so an Archive from the Xcode GUI, which does not
 * inherit a shell environment, still has one. `bakedEndpoint`, the plugin's
 * validated `endpoint` option, is exported the same way, ahead of the
 * environment and credentials.json; without it the CLI keeps its default.
 */
export declare function dsymPostActionScript(bakedToken?: string, bakedEndpoint?: string): string;
export declare const DSYM_POST_ACTION_SCRIPT: string;
