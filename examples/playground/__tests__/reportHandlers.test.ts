import { REPORT_HANDLER_PRESETS } from '../src/reportHandlers';
const fakeReport = () => ({
  id: 'r', type: 'bug', setLabels: jest.fn(), getLabels: jest.fn().mockResolvedValue(['a']),
  getAttachmentNames: jest.fn().mockResolvedValue([]), addDataAttachment: jest.fn(), update: jest.fn(),
});
test('labels preset is idempotent (setLabels, not append)', async () => {
  const r = fakeReport();
  await REPORT_HANDLER_PRESETS.labels.onAfterReportCreated!(r as never);
  await REPORT_HANDLER_PRESETS.labels.onAfterReportCreated!(r as never);
  expect(r.setLabels).toHaveBeenLastCalledWith(['a', 'from-handler']);
});
test('attachFile preset checks names before adding', async () => {
  const r = fakeReport();
  r.getAttachmentNames.mockResolvedValueOnce([]).mockResolvedValueOnce(['handler.txt']);
  await REPORT_HANDLER_PRESETS.attachFile.onAfterReportCreated!(r as never);
  await REPORT_HANDLER_PRESETS.attachFile.onAfterReportCreated!(r as never);
  expect(r.addDataAttachment).toHaveBeenCalledTimes(1);
});
test('drop preset redacts the report', async () => {
  const r = fakeReport();
  await REPORT_HANDLER_PRESETS.drop.onAfterReportCreated!(r as never);
  expect(r.update).toHaveBeenCalledWith({ summary: '[dropped by handler]', clearAttributes: true });
});
