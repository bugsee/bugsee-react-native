/**
 * The "Bundle React Native code and images" shell script from the bare
 * example's pbxproj. It runs `bugsee-xcode.sh`, which makes
 * `REACT_NATIVE_PATH` absolute with `cd`/`pwd`, injects after compose, and
 * uploads the composed map when a real token is configured.
 */
export declare const BARE_BUNDLE_SCRIPT: string;
export interface BundlePhaseSettings {
    /** `false` exports BUGSEE_UPLOAD_SOURCEMAPS=false for bugsee-xcode.sh. */
    readonly uploadSourcemaps?: boolean;
    /** Exported as BUGSEE_PLUGIN_APP_TOKEN, ahead of every other token source. */
    readonly iosAppToken?: string;
}
export declare const UNRECOGNISED_BUNDLE_PHASE: string;
/**
 * Wires bugsee-xcode.sh into the bundle phase. Only the two shapes the
 * templates write are rewritten; any other script is refused rather than
 * guessed at. A phase this plugin already rewrote keeps its body and gets
 * its settings block replaced, so a later prebuild can change them.
 */
export declare function rewriteBundlePhase(script: string, settings?: BundlePhaseSettings): string;
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
export declare function rewriteProjectBundlePhase(project: XcodeProjectLike, settings?: BundlePhaseSettings): void;
