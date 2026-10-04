/** Node --print source. Prints the CLI package.json path, or '' when missing. */
export declare const RESOLVE_BUGSEE_CLI_PACKAGE: string;
export declare function resolveNativeCliPackageSource(packageJson: string): string;
/**
 * The Archive post-action script. `bakedToken` is the plugin's iOS token,
 * written into the script so an Archive from the Xcode GUI, which does not
 * inherit a shell environment, still has one.
 */
export declare function dsymPostActionScript(bakedToken?: string): string;
export declare const DSYM_POST_ACTION_SCRIPT: string;
