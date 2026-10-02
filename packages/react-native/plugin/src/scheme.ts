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

/**
 * Inserts the Archive post-action. The EnvironmentBuildable is the scheme's
 * own app target, so ARCHIVE_PATH is provided.
 */
export function insertDsymPostAction(scheme: string, script: string = DSYM_POST_ACTION_SCRIPT): string {
  if (scheme.includes('xcode post-action')) {
    return scheme;
  }
  const archive = scheme.match(/<ArchiveAction\b[\s\S]*?<\/ArchiveAction>/);
  if (!archive?.[0]) {
    throw new Error('ArchiveAction missing');
  }
  const reference = appBuildableReference(scheme);
  const block = [
    '      <PostActions>',
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
    '      </PostActions>',
  ].join('\n');
  const updated = archive[0].replace('</ArchiveAction>', `${block}\n   </ArchiveAction>`);
  return scheme.replace(archive[0], updated);
}
