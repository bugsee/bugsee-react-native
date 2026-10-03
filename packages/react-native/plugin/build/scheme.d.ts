import { DSYM_POST_ACTION_SCRIPT } from './dsym-script';
export { DSYM_POST_ACTION_SCRIPT };
export declare function encodeXmlAttr(value: string): string;
/**
 * Inserts the Archive post-action. The EnvironmentBuildable is the scheme's
 * own app target, so ARCHIVE_PATH is provided. Xcode allows one PostActions
 * element; a scheme that already has one gets another ExecutionAction inside
 * it. A wrapping PostActions is emitted only when ArchiveAction has none.
 */
export declare function insertDsymPostAction(scheme: string, script?: string): string;
