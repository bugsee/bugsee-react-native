export const KNOWN_ISSUES = {
  'cocoa-196': {
    url: 'https://github.com/bugsee/bugsee-cocoa/issues/196',
    title: 'capture.video=false still records',
    platform: 'ios',
  },
  'cocoa-195': {
    url: 'https://github.com/bugsee/bugsee-cocoa/issues/195',
    title: 'deleteCollectedDataOnDevice only empties the legacy folder; capture data stays',
    platform: 'ios',
  },
  'android-250': {
    url: 'https://github.com/bugsee/bugsee-android/issues/250',
    title: 'deleteCollectedDataOnDevice(false) also deletes the rolling capture',
    platform: 'android',
  },
  'cocoa-220': {
    url: 'https://github.com/bugsee/bugsee-cocoa/issues/220',
    title: 'Report-handler edits on a recovered crash are lost',
    platform: 'ios',
  },
  'cocoa-224': {
    url: 'https://github.com/bugsee/bugsee-cocoa/issues/224',
    title: 'A second createReport wipes the first',
    platform: 'ios',
  },
  'cocoa-226': {
    url: 'https://github.com/bugsee/bugsee-cocoa/issues/226',
    title: 'logException includeVideo ignored',
    platform: 'ios',
  },
  'android-247': {
    url: 'https://github.com/bugsee/bugsee-android/issues/247',
    title: 'logException labels and includeVideo ignored',
    platform: 'android',
  },
  'android-248': {
    url: 'https://github.com/bugsee/bugsee-android/issues/248',
    title: 'Blackout before launch is a no-op',
    platform: 'android',
  },
  'cocoa-223': {
    url: 'https://github.com/bugsee/bugsee-cocoa/issues/223',
    title: 'upload() source type shows as unknown',
    platform: 'ios',
  },
} as const satisfies Record<string, { url: string; title: string; platform: 'ios' | 'android' }>;
export type KnownIssueId = keyof typeof KNOWN_ISSUES;
