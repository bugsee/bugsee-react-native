import Bugsee, { LogLevel } from '@bugsee/react-native';
import { PlaygroundNative } from '../../../modules/playground-native';
import type { Action } from '../../ui/action';

const levels: [string, string, LogLevel][] = [
  ['error', 'Error', LogLevel.Error], ['warning', 'Warning', LogLevel.Warning], ['info', 'Info', LogLevel.Info],
  ['debug', 'Debug', LogLevel.Debug], ['verbose', 'Verbose', LogLevel.Verbose],
];

export const loggingActions: Action[] = [
  ...levels.map(([id, name, level]): Action => ({
    id: `log-${id}`, label: `Log at ${name}`, call: `Bugsee.log('${name} line', LogLevel.${name})`,
    expect: `A line at ${name} in the report's console, source Custom`,
    run: () => Bugsee.log(`${name} line`, level),
  })),
  { id: 'console-log', label: 'console.log', call: "console.log('console.log line')", expect: 'Printed to Metro and captured in the report console (if capture.logs is on)', run: () => console.log('console.log line') },
  { id: 'console-info', label: 'console.info', call: "console.info('console.info line')", expect: 'Printed to Metro and captured in the report console (if capture.logs is on)', run: () => console.info('console.info line') },
  { id: 'console-warn', label: 'console.warn', call: "console.warn('console.warn line')", expect: 'Printed to Metro and captured in the report console (if capture.logs is on)', run: () => console.warn('console.warn line') },
  { id: 'console-error', label: 'console.error', call: "console.error('console.error line')", expect: 'Printed to Metro and captured in the report console (if capture.logs is on)', run: () => console.error('console.error line') },
  { id: 'native-log', label: 'Native log line', call: "PlaygroundNative.log('info', 'native line')", expect: 'An os_log/NSLog line (iOS) or a Logcat line tagged Playground (Android) in the report console', run: () => PlaygroundNative.log('info', 'native line') },
  {
    id: 'log-burst', label: 'Log burst', call: 'Bugsee.log(…) ×500', expect: '500 numbered lines, in order, none missing',
    run: () => { for (let i = 0; i < 500; i++) Bugsee.log(`burst ${i}`); },
  },
  { id: 'log-filter-drop', label: 'Log filter: drop "secret" lines', call: "Bugsee.setLogFilter((l) => (l.includes('secret') ? null : l))", expect: "A following 'secret' line is absent from the report", run: () => Bugsee.setLogFilter((l) => (l.includes('secret') ? null : l)) },
  { id: 'log-filter-rewrite', label: 'Log filter: mask card numbers', call: "Bugsee.setLogFilter((l) => l.replace(/\\d{4}-\\d{4}-\\d{4}-\\d{4}/g, '****'))", expect: 'Card numbers appear as ****', run: () => Bugsee.setLogFilter((l) => l.replace(/\d{4}-\d{4}-\d{4}-\d{4}/g, '****')) },
  { id: 'log-filter-off', label: 'Log filter: off', call: 'Bugsee.setLogFilter(null)', expect: 'Subsequent lines appear unmodified', run: () => Bugsee.setLogFilter(null) },
  { id: 'log-sensitive', label: 'Log a sensitive line', call: "console.log('secret token=abc 4111-1111-1111-1111')", expect: 'With the drop filter the line is absent; with the rewrite filter the card shows ****; with no filter it appears verbatim', run: () => console.log('secret token=abc 4111-1111-1111-1111') },
];
