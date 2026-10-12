import Bugsee from '@bugsee/react-native';
import type { BugseeReportHandler } from '@bugsee/react-native';
import type { ReportHandlerChoice } from './session/config';

export const HANDLER_ATTACHMENT = 'handler.txt';

export const REPORT_HANDLER_PRESETS: Record<'labels' | 'attachFile' | 'drop', BugseeReportHandler> = {
  // setLabels replaces the list, so a repeated call stays idempotent.
  labels: {
    onAfterReportCreated: async (report) => {
      const labels = await report.getLabels();
      await report.setLabels([...new Set([...labels, 'from-handler'])]);
    },
  },
  attachFile: {
    onAfterReportCreated: async (report) => {
      const names = await report.getAttachmentNames();
      if (names.includes(HANDLER_ATTACHMENT)) return;
      await report.addDataAttachment(globalThis.btoa('attached by the report handler'), {
        name: HANDLER_ATTACHMENT,
        mimeType: 'text/plain',
      });
    },
  },
  // There is no drop API in 7.x: redact instead.
  drop: {
    onAfterReportCreated: async (report) => {
      await report.update({ summary: '[dropped by handler]', clearAttributes: true });
    },
  },
};

/** The handler for a saved choice; `null` for 'none'. */
export const reportHandlerFor = (choice: ReportHandlerChoice): BugseeReportHandler | null =>
  choice === 'none' ? null : REPORT_HANDLER_PRESETS[choice];

/**
 * Installs the saved handler. Called before every launch: handlers live only in JS memory, and one set after
 * launch() misses the reports the SDK recovers at that launch (a crash from the previous run).
 */
export function installReportHandler(choice: ReportHandlerChoice): void {
  Bugsee.setReportHandler(reportHandlerFor(choice));
}
