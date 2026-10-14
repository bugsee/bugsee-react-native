export const KNOWN_ISSUES = {
  'cocoa-224': {
    url: 'https://github.com/bugsee/bugsee-cocoa/issues/224',
    title: 'A second createReport wipes the first',
    platform: 'ios',
  },
  'cocoa-223': {
    url: 'https://github.com/bugsee/bugsee-cocoa/issues/223',
    title: 'upload() source type shows as unknown',
    platform: 'ios',
  },
} as const satisfies Record<string, { url: string; title: string; platform: 'ios' | 'android' }>;
export type KnownIssueId = keyof typeof KNOWN_ISSUES;
