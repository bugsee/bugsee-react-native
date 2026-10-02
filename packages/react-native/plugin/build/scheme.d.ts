import { DSYM_POST_ACTION_SCRIPT } from './dsym-script';
export { DSYM_POST_ACTION_SCRIPT };
export declare function encodeXmlAttr(value: string): string;
/**
 * Inserts the bare example's Archive post-action. The script is not
 * rewritten. The EnvironmentBuildable is the scheme's own app target, so
 * ARCHIVE_PATH is provided.
 */
export declare function insertDsymPostAction(scheme: string, script?: string): string;
