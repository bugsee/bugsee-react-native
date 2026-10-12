import { useEffect } from 'react';
import Bugsee, { IssueSeverity } from '@bugsee/react-native';
import type { BugseeCreatedReport } from '@bugsee/react-native';
import * as Feedback from '@bugsee/react-native-feedback';
import { File, Paths } from 'expo-file-system';
import { installReportHandler } from '../reportHandlers';
import { patchConfig } from '../session/config';
import type { ReportHandlerChoice } from '../session/config';
import { ActionButton } from '../ui/ActionButton';
import type { Action } from '../ui/action';
import { useLog } from '../ui/ResultLog';
import { Screen } from '../ui/Screen';
import { Section } from '../ui/Section';

let created: BugseeCreatedReport | null = null;
let screenLog: (l: string) => void = () => {};

const base64 = (s: string) => globalThis.btoa(s);
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** Test-only: forget the created report and the screen log sink. */
export const resetReportsState = () => {
  created = null;
  screenLog = () => {};
};
const current = (): BugseeCreatedReport => {
  if (!created) throw new Error('Call Bugsee.createReport() first');
  return created;
};

const reportActions: Action[] = [
  {
    id: 'dialog-prefilled',
    label: 'Show report dialog (prefilled)',
    call: "Bugsee.showReportDialog('Playground report', 'Prefilled description', IssueSeverity.High, ['playground'])",
    expect: 'The dialog opens pre-filled; Send creates one report',
    run: () =>
      Bugsee.showReportDialog('Playground report', 'Prefilled description', IssueSeverity.High, ['playground']),
  },
  {
    id: 'dialog-empty',
    label: 'Show report dialog (empty)',
    call: 'Bugsee.showReportDialog()',
    expect: 'The dialog opens with empty fields',
    run: () => Bugsee.showReportDialog(),
  },
  {
    id: 'upload',
    label: 'Upload report (no UI)',
    call: "Bugsee.upload('Playground upload', 'Sent with no UI', IssueSeverity.Medium, ['playground', 'upload'])",
    expect: 'A bug report appears on the dashboard with these fields',
    knownIssue: 'cocoa-223',
    run: () => Bugsee.upload('Playground upload', 'Sent with no UI', IssueSeverity.Medium, ['playground', 'upload']),
  },
  {
    id: 'view-hierarchy',
    label: 'Capture view hierarchy',
    call: 'Bugsee.captureViewHierarchy()',
    expect: 'The next report carries the React Native view tree (Bugsee.wrap in app/_layout.tsx)',
    run: () => Bugsee.captureViewHierarchy(),
  },
];

const createdActions: Action[] = [
  {
    id: 'created-create',
    label: 'Create report',
    call: 'Bugsee.createReport()',
    expect: 'Resolves an object; a second create before upload rejects with E_REPORT_CREATE_BUSY',
    knownIssue: 'cocoa-224',
    run: async () => {
      created = (await Bugsee.createReport()) ?? null;
      return created ? 'created' : 'null';
    },
  },
  {
    id: 'created-update',
    label: 'Report: update',
    call: "report.update({ summary: 'Created report', labels: ['created'], attributes: { step: 1 } })",
    expect: 'After upload: summary Created report, label created, attribute step=1',
    run: () => current().update({ summary: 'Created report', labels: ['created'], attributes: { step: 1 } }),
  },
  {
    id: 'created-attach-text',
    label: 'Report: attach text',
    call: "report.addDataAttachment(base64('hello from the playground'), { name: 'note.txt', mimeType: 'text/plain' })",
    expect: 'note.txt is attached to the uploaded report',
    run: () =>
      current().addDataAttachment(base64('hello from the playground'), { name: 'note.txt', mimeType: 'text/plain' }),
  },
  {
    id: 'created-attach-file',
    label: 'Report: attach a file',
    call: "report.addFileAttachment(path, { name: 'note-file.txt', mimeType: 'text/plain' })",
    expect: 'note-file.txt (written to the cache directory first) is attached to the uploaded report',
    run: () => {
      const report = current();
      const file = new File(Paths.cache, 'note-file.txt');
      file.write('A file from the playground cache directory');
      // A file:// URI is accepted; the SDK copies the file when it is added.
      return report.addFileAttachment(file.uri, { name: 'note-file.txt', mimeType: 'text/plain' });
    },
  },
  {
    id: 'created-attach-png',
    label: 'Report: attach PNG',
    call: "report.addDataAttachment(PIXEL_PNG, { name: 'pixel.png', mimeType: 'image/png' })",
    expect: 'pixel.png is attached to the uploaded report',
    run: () => current().addDataAttachment(PIXEL_PNG, { name: 'pixel.png', mimeType: 'image/png' }),
  },
  {
    id: 'created-attach-big',
    label: 'Report: attach 4 MiB',
    call: "report.addDataAttachment(base64('A'.repeat(4 * 1024 * 1024)), { name: 'big.bin' })",
    expect: 'iOS rejects with E_REPORT_ATTACHMENT_REJECTED (3 MiB cap); Android accepts',
    run: () => current().addDataAttachment(base64('A'.repeat(4 * 1024 * 1024)), { name: 'big.bin' }),
  },
  {
    id: 'created-read',
    label: 'Report: read',
    call: 'report.read()',
    expect: 'Snapshot shows the summary, labels, attributes and attachment names set so far',
    run: () => current().read(),
  },
  {
    id: 'created-upload',
    label: 'Report: upload',
    call: 'report.upload()',
    expect: 'Resolves true and clears the handle; false keeps it for a retry',
    run: async () => {
      const uploaded = await current().upload();
      if (uploaded) created = null;
      return uploaded;
    },
  },
];

/** Installs the preset now and saves it, so the next launch installs it before the SDK recovers a crash. */
const chooseHandler = async (choice: ReportHandlerChoice) => {
  installReportHandler(choice);
  await patchConfig({ reportHandler: choice });
  return `${choice} (saved; installed before every launch)`;
};

const handlerActions: Action[] = [
  {
    id: 'handler-labels',
    label: 'Handler: add label',
    call: 'Bugsee.setReportHandler(REPORT_HANDLER_PRESETS.labels)',
    expect: 'The next report carries label from-handler, including a crash recovered at the next launch',
    knownIssue: 'cocoa-220',
    run: () => chooseHandler('labels'),
  },
  {
    id: 'handler-attach',
    label: 'Handler: attach file',
    call: 'Bugsee.setReportHandler(REPORT_HANDLER_PRESETS.attachFile)',
    expect: 'handler.txt attached, including to a crash recovered at the next launch',
    run: () => chooseHandler('attachFile'),
  },
  {
    id: 'handler-drop',
    label: 'Redact (no drop API in 7.x)',
    call: 'Bugsee.setReportHandler(REPORT_HANDLER_PRESETS.drop)',
    expect: 'Summary [dropped by handler], attributes cleared',
    run: () => chooseHandler('drop'),
  },
  {
    id: 'handler-clear',
    label: 'Handler: clear',
    call: 'Bugsee.setReportHandler(null)',
    expect: 'Reports are no longer modified, from the next launch on too',
    run: () => chooseHandler('none'),
  },
];

const notifyActions: Action[] = [
  {
    id: 'notify',
    label: 'Notify',
    call: "Bugsee.notify('Playground notification', 'Body text', IssueSeverity.Medium, { source: 'playground' })",
    expect: "Delivered to the app's messaging integrations; not a bug report",
    run: () => Bugsee.notify('Playground notification', 'Body text', IssueSeverity.Medium, { source: 'playground' }),
  },
  {
    id: 'notify-urgent',
    label: 'Notify (urgent)',
    call: "Bugsee.notify('Playground notification', 'Body text', IssueSeverity.Medium, { source: 'playground' }, true)",
    expect: "Delivered to the app's messaging integrations as urgent; not a bug report",
    run: () =>
      Bugsee.notify('Playground notification', 'Body text', IssueSeverity.Medium, { source: 'playground' }, true),
  },
];

const colourActions: Action[] = [
  {
    id: 'appearance-set',
    label: 'Set report colours',
    call: "Bugsee.appearance.backgroundColor = '#1d2939'",
    expect: 'The report dialog uses these colours (dark background, white text)',
    run: () => {
      Bugsee.appearance.backgroundColor = '#1d2939';
      Bugsee.appearance.textColor = '#ffffff';
    },
  },
  {
    id: 'appearance-reset',
    label: 'Reset colours',
    call: "Bugsee.appearance.backgroundColor = '#ffffff'",
    expect: 'The report dialog uses these colours (white background, dark text)',
    run: () => {
      Bugsee.appearance.backgroundColor = '#ffffff';
      Bugsee.appearance.textColor = '#101828';
    },
  },
];

const feedbackActions: Action[] = [
  {
    id: 'feedback-show',
    label: 'Show feedback UI',
    call: 'Feedback.showFeedbackUI()',
    expect: 'The feedback chat opens (first time: the e-mail screen)',
    run: () => Feedback.showFeedbackUI(),
  },
  {
    id: 'feedback-greeting',
    label: 'Set greeting',
    call: "Feedback.setGreeting('Hi from the playground!')",
    expect: 'The chat opens with this greeting',
    knownIssue: 'android-245',
    run: () => Feedback.setGreeting('Hi from the playground!'),
  },
  {
    id: 'feedback-greeting-null',
    label: 'Clear greeting',
    call: 'Feedback.setGreeting(null)',
    expect: 'The chat opens with the default greeting',
    run: () => Feedback.setGreeting(null),
  },
  {
    id: 'feedback-listener',
    label: 'Set feedback listener',
    call: 'Feedback.setListener({ onNewMessagesReceived, onNewMessageSent })',
    expect: 'Sending or receiving a feedback message adds a line to the log below',
    run: () =>
      Feedback.setListener({
        onNewMessagesReceived: (m) => screenLog(`feedback received: ${JSON.stringify(m)}`),
        onNewMessageSent: (m) => screenLog(`feedback sent: ${JSON.stringify(m)}`),
      }),
  },
  {
    id: 'feedback-listener-null',
    label: 'Clear feedback listener',
    call: 'Feedback.setListener(null)',
    expect: 'No more feedback lines in the log',
    run: () => Feedback.setListener(null),
  },
  // `Feedback.appearance.` parses as Feedback/appearance in callTarget.
  {
    id: 'feedback-appearance',
    label: 'Set feedback colours',
    call: "Feedback.appearance.outgoingBubbleColor = '#7f56d9'",
    expect: 'Outgoing bubbles purple, incoming bubbles light grey',
    run: () => {
      Feedback.appearance.outgoingBubbleColor = '#7f56d9';
      Feedback.appearance.incomingBubbleColor = '#eaecf0';
    },
  },
];

export const reportsActions: Action[] = [
  ...reportActions,
  ...createdActions,
  ...handlerActions,
  ...notifyActions,
  ...colourActions,
  ...feedbackActions,
];

const group = (list: Action[]) => list.map((a) => <ActionButton key={a.id} action={a} />);

// useLog only works below <Screen>, which owns the result log, so the sink lives in a child.
function FeedbackLogSink() {
  const log = useLog();
  useEffect(() => {
    screenLog = log;
    return () => {
      screenLog = () => {};
    };
  }, [log]);
  return null;
}

export default function ReportsScreen() {
  return (
    <Screen title="Reports">
      <FeedbackLogSink />
      <Section title="Report">{group(reportActions)}</Section>
      <Section title="Created report">{group(createdActions)}</Section>
      <Section title="Report handler">{group(handlerActions)}</Section>
      <Section title="Notify">{group(notifyActions)}</Section>
      <Section title="Report UI colours">{group(colourActions)}</Section>
      <Section title="Feedback">{group(feedbackActions)}</Section>
    </Screen>
  );
}
