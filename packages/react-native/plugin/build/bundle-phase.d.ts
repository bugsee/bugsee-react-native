/**
 * The "Bundle React Native code and images" shell script from the bare
 * example's pbxproj. It runs `bugsee-xcode.sh`, which makes
 * `REACT_NATIVE_PATH` absolute with `cd`/`pwd` and injects after compose.
 * The upload function in that script is not executed.
 */
export declare const BARE_BUNDLE_SCRIPT: string;
export declare function rewriteBundlePhase(script: string): string;
export interface ShellPhase {
    isa?: string;
    name?: string;
    shellScript?: string;
}
export interface XcodeProjectLike {
    hash?: {
        project?: {
            objects?: {
                PBXShellScriptBuildPhase?: Record<string, ShellPhase | string | undefined>;
            };
        };
    };
}
export declare function rewriteProjectBundlePhase(project: XcodeProjectLike): void;
