import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { Logcat } from '../../examples/bare/e2e/scenario';

/**
 * `Logcat`'s constructor fed both of `adb logcat`'s streams (stdout and
 * stderr) through `DeviceLog.feed()` with the default source (`this`), so a
 * partial line left on one stream could be completed by a chunk that arrived
 * on the other -- the same bug Task 3.H's M1 fixed for `IosConsole.launch()`.
 * `feed()` takes a `source` key precisely so two streams keep independent
 * partial-line buffers; this proves `Logcat` now passes one per stream too.
 */
describe('Logcat stdout/stderr line buffering', () => {
  function fakeChild(): { child: ChildProcess; stdout: EventEmitter; stderr: EventEmitter } {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = { stdout, stderr, kill: jest.fn() } as unknown as ChildProcess;
    return { child, stdout, stderr };
  }

  it('does not splice a partial stdout line with a complete stderr line', () => {
    const { child, stdout, stderr } = fakeChild();
    const LogcatCtor = Logcat as unknown as new (c: ChildProcess) => Logcat;
    const log = new LogcatCtor(child);

    // A partial stdout line: no trailing newline yet.
    stdout.emit('data', Buffer.from('OUT-PART'));
    // A complete stderr line arrives before stdout's line does. Sharing one
    // buffer would complete stdout's partial as "OUT-PARTERR-LINE" here.
    stderr.emit('data', Buffer.from('ERR-LINE\n'));
    expect(log.lines.map(l => l.text)).toEqual(['ERR-LINE']);

    // Completing stdout's own partial line must read back exactly what
    // stdout sent, from its own buffer.
    stdout.emit('data', Buffer.from('-DONE\n'));
    expect(log.lines.map(l => l.text)).toEqual(['ERR-LINE', 'OUT-PART-DONE']);
  });

  it('keeps two interleaved partial lines, one per stream, independent', () => {
    const { child, stdout, stderr } = fakeChild();
    const LogcatCtor = Logcat as unknown as new (c: ChildProcess) => Logcat;
    const log = new LogcatCtor(child);

    stdout.emit('data', Buffer.from('A'));
    stderr.emit('data', Buffer.from('B'));
    stdout.emit('data', Buffer.from('1\n'));
    stderr.emit('data', Buffer.from('2\n'));

    expect(log.lines.map(l => l.text)).toEqual(['A1', 'B2']);
  });
});
