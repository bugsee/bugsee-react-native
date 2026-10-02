package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.common.Callback1;
import com.bugsee.library.contracts.exchange.LogEvent;
import com.bugsee.library.contracts.internal.LogSource;
import com.bugsee.library.contracts.options.LogLevel;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * A reply that arrives after bugsee-android has recycled the pooled log entry
 * must not call {@code setMessage} or {@code callback.run}. The SDK has
 * already dropped the line; touching the entry writes onto whatever line owns
 * it now.
 */
public class LogFilterBridgeTest {

    /** Runs a task only when the test says so. */
    private static final class ManualScheduler implements LogFilterBridge.Scheduler {
        static final class Task implements LogFilterBridge.Cancellable {
            final Runnable runnable;
            final long delayMs;
            boolean cancelled;

            Task(final Runnable runnable, final long delayMs) {
                this.runnable = runnable;
                this.delayMs = delayMs;
            }

            @Override
            public void cancel() {
                cancelled = true;
            }
        }

        final List<Task> tasks = new ArrayList<>();

        @Override
        @NonNull
        public LogFilterBridge.Cancellable schedule(@NonNull final Runnable task, final long delayMs) {
            final Task scheduled = new Task(task, delayMs);
            tasks.add(scheduled);
            return scheduled;
        }

        void fire() {
            for (final Task task : new ArrayList<>(tasks)) {
                if (!task.cancelled) {
                    task.runnable.run();
                }
            }
        }
    }

    /** Counts {@code run} and remembers the argument, including {@code null}. */
    private static final class RecordingCallback implements Callback1<LogEvent> {
        int runs;
        @Nullable
        LogEvent last;
        boolean sawNull;

        @Override
        public void run(final LogEvent value) {
            runs++;
            last = value;
            if (value == null) {
                sawNull = true;
            }
        }
    }

    /** Records the request id the bridge asked this sink to filter. */
    private static final class RecordingSink implements LogFilterBridge.Sink {
        final List<String> ids = new ArrayList<>();

        @Override
        public void onLogFilterRequest(@NonNull final String requestId, @NonNull final String line) {
            ids.add(requestId);
        }
    }

    /**
     * {@code message} is a field the test assigns directly, the way the SDK's
     * pool reuses an entry: {@code setMessage} is not how a recycle lands.
     */
    private static final class MutableLog implements LogEvent {
        @Nullable
        String message;
        int setMessageCalls;

        MutableLog(@NonNull final String message) {
            this.message = message;
        }

        @Override
        public long getTimestamp() {
            return 1L;
        }

        @Override
        @NonNull
        public LogSource getLogSource() {
            return LogSource.Custom;
        }

        @Override
        @Nullable
        public String getMessage() {
            return message;
        }

        @Override
        public void setMessage(@Nullable final String message) {
            setMessageCalls++;
            this.message = message;
        }

        @Override
        public LogLevel getLevel() {
            return LogLevel.Info;
        }
    }

    private final ManualScheduler scheduler = new ManualScheduler();
    private final LogFilterBridge bridge = new LogFilterBridge(scheduler);

    @Test
    public void aReplyAfterTheMessageChangedDoesNotTouchTheEntry() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final MutableLog event = new MutableLog("secret");
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(event, callback);
        final String id = sink.ids.get(0);

        // The pool recycled the entry and lent it to another line.
        event.message = "another line";
        bridge.reply(id, "redacted");

        assertEquals(0, event.setMessageCalls);
        assertEquals("another line", event.message);
        assertEquals(0, callback.runs);
        assertEquals(LogFilterBridge.BORROW_MS, scheduler.tasks.get(0).delayMs);
    }

    @Test
    public void detachingAnOldSinkDropsItsPendingWithoutTouchingARecycledEntry() {
        final RecordingSink stale = new RecordingSink();
        bridge.attach(stale);
        final MutableLog event = new MutableLog("secret");
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(event, callback);
        final String id = stale.ids.get(0);

        event.message = "another line";
        final RecordingSink current = new RecordingSink();
        bridge.attach(current);
        bridge.detach(stale);

        assertEquals(0, callback.runs);
        assertEquals(0, event.setMessageCalls);
        bridge.reply(id, "redacted");
        assertEquals(0, callback.runs);
        assertEquals(0, event.setMessageCalls);
        assertEquals("another line", event.message);

        // The newer sink is still the one a later line is asked of.
        final MutableLog next = new MutableLog("kept");
        final RecordingCallback nextCallback = new RecordingCallback();
        bridge.ask(next, nextCallback);
        assertEquals(1, current.ids.size());
        assertEquals(1, stale.ids.size());
    }

    /**
     * The deadline elapses and the message is still the original, including
     * the same text a recycled entry would show for another line. The reply
     * does not call {@code setMessage} or {@code callback.run}.
     */
    @Test
    public void aReplyAfterTheDeadlineIsANoOpWhenTheMessageIsUnchanged() {
        assertTrue(LogFilterBridge.BORROW_MS < 10_000L);
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final MutableLog event = new MutableLog("secret");
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(event, callback);

        scheduler.fire();
        bridge.reply(sink.ids.get(0), "redacted");

        assertEquals("secret", event.message);
        assertEquals(0, event.setMessageCalls);
        assertEquals(0, callback.runs);
    }

    /**
     * The deadline elapses and the message is still the original. The
     * deadline forgets the pending and does not pass the line through. A
     * later reply finds nothing.
     */
    @Test
    public void aDeadlineForgetsThePendingWithoutCallingTheCallback() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final MutableLog event = new MutableLog("secret");
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(event, callback);

        scheduler.fire();
        bridge.reply(sink.ids.get(0), "secret");

        assertEquals(0, callback.runs);
        assertEquals(0, event.setMessageCalls);
        assertEquals("secret", event.message);
    }

    /** While the entry is still the borrowed line, a replacement is written back. */
    @Test
    public void aReplyWhileTheEntryIsStillTheOriginalWritesItBack() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final MutableLog event = new MutableLog("secret");
        final RecordingCallback callback = new RecordingCallback();
        bridge.ask(event, callback);

        bridge.reply(sink.ids.get(0), "redacted");

        assertEquals(1, event.setMessageCalls);
        assertEquals("redacted", event.message);
        assertEquals(1, callback.runs);
        assertSame(event, callback.last);
        assertTrue(scheduler.tasks.get(0).cancelled);
    }

    /** A live borrow is dropped. A recycled one is only forgotten. */
    @Test
    public void detachDropsALiveBorrowAndSkipsARecycledOne() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final MutableLog live = new MutableLog("keep-or-drop");
        final RecordingCallback liveCallback = new RecordingCallback();
        bridge.ask(live, liveCallback);
        final MutableLog recycled = new MutableLog("secret");
        final RecordingCallback recycledCallback = new RecordingCallback();
        bridge.ask(recycled, recycledCallback);
        recycled.message = null;

        bridge.detach(sink);

        assertEquals(1, liveCallback.runs);
        assertTrue(liveCallback.sawNull);
        assertNull(liveCallback.last);
        assertEquals(0, recycledCallback.runs);
        assertEquals(0, recycled.setMessageCalls);
    }

    /**
     * The channel line is asked. The logcat echo of the same text is dropped
     * without a second ask, so the user's filter runs once.
     */
    @Test
    public void routeAsksTheChannelLineAndDropsItsLogcatEcho() {
        final RecordingSink sink = new RecordingSink();
        bridge.attach(sink);
        final RecordingCallback channelCallback = new RecordingCallback();
        bridge.route(new SourcedLog(LogSource.Custom, null, "hello"), channelCallback);

        assertEquals(1, sink.ids.size());
        assertEquals(0, channelCallback.runs);

        final RecordingCallback echoCallback = new RecordingCallback();
        bridge.route(
                new SourcedLog(LogSource.LogCat, ConsoleEchoDedup.JS_CONSOLE_TAG, "hello"),
                echoCallback);

        assertEquals(1, sink.ids.size());
        assertEquals(1, echoCallback.runs);
        assertTrue(echoCallback.sawNull);
    }

    /** Logcat line with a source and a tag, for the echo route. */
    private static final class SourcedLog implements LogEvent {
        private final LogSource source;
        private final String tag;
        private final String message;

        SourcedLog(final LogSource source, final String tag, final String message) {
            this.source = source;
            this.tag = tag;
            this.message = message;
        }

        @Override
        public long getTimestamp() {
            return 1L;
        }

        @Override
        @NonNull
        public LogSource getLogSource() {
            return source;
        }

        @Override
        @Nullable
        public String getMessage() {
            return message;
        }

        @Override
        public LogLevel getLevel() {
            return LogLevel.Info;
        }

        @Override
        @Nullable
        public String getTag() {
            return tag;
        }
    }
}
