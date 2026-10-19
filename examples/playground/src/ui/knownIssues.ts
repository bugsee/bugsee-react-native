export interface KnownIssueEntry {
  url: string;
  title: string;
  platform: 'ios' | 'android';
}

// Empty at the pinned SDK versions: iOS 7.0.0-beta7 fixed bugsee-cocoa#223 and #224. Add an entry here (and
// `knownIssue: '<id>'` on the affected action) when an SDK bug affects a playground action.
export const KNOWN_ISSUES: Record<string, KnownIssueEntry> = {};
export type KnownIssueId = string;
