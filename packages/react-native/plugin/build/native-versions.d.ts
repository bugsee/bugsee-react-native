export interface AndroidNativeVersions {
    readonly sdk: string;
    readonly gradlePlugin: string;
}
/**
 * `build:plugin` copies `android.sdk` and `android.gradlePlugin` from the
 * repo-root native-versions.json into `native-versions.baked.json` beside
 * this module. A published install has no repo-root JSON to walk to.
 */
export declare function loadNativeVersions(moduleDir?: string): AndroidNativeVersions;
