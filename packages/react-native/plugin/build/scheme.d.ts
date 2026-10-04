import { DSYM_POST_ACTION_SCRIPT } from './dsym-script';
export { DSYM_POST_ACTION_SCRIPT };
export declare function encodeXmlAttr(value: string): string;
/**
 * Inserts the Archive post-action. The EnvironmentBuildable is the scheme's
 * own app target, so ARCHIVE_PATH is provided. Xcode allows one PostActions
 * element; a scheme that already has one gets another ExecutionAction inside
 * it. A wrapping PostActions is emitted only when ArchiveAction has none.
 * An action an earlier prebuild inserted is replaced, so a changed token
 * reaches the scheme.
 */
export declare function insertDsymPostAction(scheme: string, script?: string): string;
/**
 * Removes the Archive post-action this plugin inserted. A later prebuild
 * with `uploadSymbols: false` has to undo an earlier default-on edit,
 * because insert is otherwise one-way. A sibling ExecutionAction stays.
 * When the Bugsee action was the only child, the wrapping PostActions
 * element goes too, so the scheme stays valid.
 */
export declare function removeDsymPostAction(scheme: string): string;
