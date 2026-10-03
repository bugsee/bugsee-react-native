import { DSYM_POST_ACTION_SCRIPT } from './dsym-script';

export { DSYM_POST_ACTION_SCRIPT };

export function encodeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}

function appBuildableReference(scheme: string): string {
  const refs = scheme.match(/<BuildableReference\b[\s\S]*?<\/BuildableReference>/g) ?? [];
  const app = refs.find((ref) => /BuildableName\s*=\s*"[^"]+\.app"/.test(ref));
  if (!app) {
    throw new Error('scheme has no .app BuildableReference');
  }
  return app;
}

function executionActionXml(reference: string, script: string): string {
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
export function insertDsymPostAction(scheme: string, script: string = DSYM_POST_ACTION_SCRIPT): string {
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

function insertArchiveExecution(archive: string, execution: string): string {
  const open = /<PostActions\b[^>]*>/.exec(archive);
  const closeAt = archive.indexOf('</PostActions>');
  if (open && closeAt > open.index) {
    const lineStart = archive.lastIndexOf('\n', closeAt - 1) + 1;
    return archive.slice(0, lineStart) + execution + '\n' + archive.slice(lineStart);
  }
  const block = ['      <PostActions>', execution, '      </PostActions>'].join('\n');
  return archive.replace('</ArchiveAction>', `${block}\n   </ArchiveAction>`);
}

const EXECUTION_ACTION = /[ \t]*<ExecutionAction\b[\s\S]*?<\/ExecutionAction>\n?/g;
const EMPTY_POST_ACTIONS = /\n[ \t]*<PostActions\b[^>]*>\s*<\/PostActions>/g;

/**
 * Removes the Archive post-action this plugin inserted. A later prebuild
 * with `uploadSymbols: false` has to undo an earlier default-on edit,
 * because insert is otherwise one-way. A sibling ExecutionAction stays.
 * When the Bugsee action was the only child, the wrapping PostActions
 * element goes too, so the scheme stays valid.
 */
export function removeDsymPostAction(scheme: string): string {
  const archive = scheme.match(/<ArchiveAction\b[\s\S]*?<\/ArchiveAction>/);
  if (!archive?.[0] || archive.index === undefined) {
    return scheme;
  }
  let removed = false;
  let archiveXml = archive[0].replace(EXECUTION_ACTION, (block) => {
    if (!block.includes('xcode post-action')) {
      return block;
    }
    removed = true;
    return '';
  });
  if (!removed) {
    return scheme;
  }
  archiveXml = archiveXml.replace(EMPTY_POST_ACTIONS, '');
  return scheme.slice(0, archive.index) + archiveXml + scheme.slice(archive.index + archive[0].length);
}
