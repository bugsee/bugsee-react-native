"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DSYM_POST_ACTION_SCRIPT = void 0;
exports.encodeXmlAttr = encodeXmlAttr;
exports.insertDsymPostAction = insertDsymPostAction;
const dsym_script_1 = require("./dsym-script");
Object.defineProperty(exports, "DSYM_POST_ACTION_SCRIPT", { enumerable: true, get: function () { return dsym_script_1.DSYM_POST_ACTION_SCRIPT; } });
function encodeXmlAttr(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\r/g, '&#13;')
        .replace(/\n/g, '&#10;');
}
function appBuildableReference(scheme) {
    const refs = scheme.match(/<BuildableReference\b[\s\S]*?<\/BuildableReference>/g) ?? [];
    const app = refs.find((ref) => /BuildableName\s*=\s*"[^"]+\.app"/.test(ref));
    if (!app) {
        throw new Error('scheme has no .app BuildableReference');
    }
    return app;
}
function executionActionXml(reference, script) {
    return [
        '         <ExecutionAction',
        '            ActionType = "Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction">',
        '            <ActionContent',
        '               title = "Upload dSYMs"',
        `               scriptText = "${encodeXmlAttr(script)}">`,
        '               <EnvironmentBuildable>',
        reference.trimEnd(),
        '               </EnvironmentBuildable>',
        '            </ActionContent>',
        '         </ExecutionAction>',
    ].join('\n');
}
/**
 * Inserts the Archive post-action. The EnvironmentBuildable is the scheme's
 * own app target, so ARCHIVE_PATH is provided. Xcode allows one PostActions
 * element; a scheme that already has one gets another ExecutionAction inside
 * it. A wrapping PostActions is emitted only when ArchiveAction has none.
 */
function insertDsymPostAction(scheme, script = dsym_script_1.DSYM_POST_ACTION_SCRIPT) {
    if (scheme.includes('xcode post-action')) {
        return scheme;
    }
    const archive = scheme.match(/<ArchiveAction\b[\s\S]*?<\/ArchiveAction>/);
    if (!archive?.[0] || archive.index === undefined) {
        throw new Error('ArchiveAction missing');
    }
    const execution = executionActionXml(appBuildableReference(scheme), script);
    const updated = insertArchiveExecution(archive[0], execution);
    return scheme.slice(0, archive.index) + updated + scheme.slice(archive.index + archive[0].length);
}
function insertArchiveExecution(archive, execution) {
    const open = /<PostActions\b[^>]*>/.exec(archive);
    const closeAt = archive.indexOf('</PostActions>');
    if (open && closeAt > open.index) {
        const lineStart = archive.lastIndexOf('\n', closeAt - 1) + 1;
        return archive.slice(0, lineStart) + execution + '\n' + archive.slice(lineStart);
    }
    const block = ['      <PostActions>', execution, '      </PostActions>'].join('\n');
    return archive.replace('</ArchiveAction>', `${block}\n   </ArchiveAction>`);
}
//# sourceMappingURL=scheme.js.map