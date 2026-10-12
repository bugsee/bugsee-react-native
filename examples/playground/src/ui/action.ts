import type { KnownIssueId } from './knownIssues';
export type Platformish = 'ios' | 'android';
export interface Action {
  id: string; label: string; call: string; expect: string; run: () => unknown;
  confirm?: string; platforms?: Platformish[]; knownIssue?: KnownIssueId;
}
export type CallObject = 'Bugsee' | 'Feedback' | 'PlaygroundNative' | 'console' | 'global' | 'report';
export function callTarget(call: string): { object: CallObject; member: string } {
  const g = /^(?:new |global )?(fetch|XMLHttpRequest|WebSocket|Promise)\b/.exec(call);
  if (g) return { object: 'global', member: g[1] };
  const m = /^(Bugsee|Feedback|PlaygroundNative|console|report)\.(\w+)/.exec(call);
  if (!m) throw new Error(`Action call has no known target: ${call}`);
  return { object: m[1] as CallObject, member: m[2] };
}
