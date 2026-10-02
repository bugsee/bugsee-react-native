package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.common.Callback1;
import com.bugsee.library.contracts.exchange.EventFilter;
import com.bugsee.library.contracts.exchange.LogEvent;
import com.bugsee.library.contracts.internal.LogSource;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The app's log filter, as a round trip into JS.
 *
 * <p>Registered with {@link Bugsee#setLogEventFilter}, the method both SDKs
 * actually install a log filter with. Android's {@code setLogFilter} is a
 * deprecated alias of that method; calling the alias would not be a second
 * filter, but it is not the method the 7.x SDK documents.
 *
 * <p>{@link #filter} returns without waiting. The SDK drops a line whose
 * callback is never run, and at 10 seconds recycles the pooled entry. This
 * bridge forgets the pending request at {@link #BORROW_MS}, strictly earlier,
 * without calling the callback. A recycled entry can carry the same text, so
 * a reply that still sees the original message must not {@code setMessage}
 * or {@code callback.run} once that deadline has passed. A missing sink, a
 * failed emit, or a {@code null} reply while {@code getMessage()} is still
 * the original line and the deadline has not fired pass {@code null} to the
 * SDK, which discards the line. Once the message is no longer that line, the
 * bridge does not call {@code setMessage} or {@code callback.run}.
 */
final class LogFilterBridge {

    /**
     * What the module implements to emit {@code onLogFilterRequest}.
     */
    interface Sink {
        void onLogFilterRequest(@NonNull String requestId, @NonNull String line);
    }

    /** Arms the moment a pending request is forgotten. Injectable so tests control time. */
    interface Cancellable {
        void cancel();
    }

    /** Arms a request's deadline. Injectable so tests control time. */
    interface Scheduler {
        @NonNull
        Cancellable schedule(@NonNull Runnable task, long delayMs);
    }

    /**
     * Strictly under {@code BugseeCaptureDataProviderLog}'s 10_000 ms
     * recycle. The SDK posts that timeout before it calls the filter, so an
     * equal delay fires after the entry is back in the pool. A pooled entry
     * reused for another line with the same text still looks borrowed.
     * Forgetting the pending here discards JS's answer; it does not pass
     * the line through.
     */
    static final long BORROW_MS = 9_000L;

    private static final class Pending {
        @NonNull final String id;
        @NonNull final LogEvent event;
        /** The line the SDK handed us. A later {@code getMessage()} that differs means the entry was recycled. */
        @NonNull final String original;
        @NonNull final Callback1<LogEvent> callback;
        @NonNull final Sink owner;
        @Nullable Cancellable deadline;

        Pending(
                @NonNull final String id,
                @NonNull final LogEvent event,
                @NonNull final String original,
                @NonNull final Callback1<LogEvent> callback,
                @NonNull final Sink owner
        ) {
            this.id = id;
            this.event = event;
            this.original = original;
            this.callback = callback;
            this.owner = owner;
        }
    }

    private static final LogFilterBridge SHARED = new LogFilterBridge();

    @NonNull
    static LogFilterBridge shared() {
        return SHARED;
    }

    private final Scheduler scheduler;
    private final ConsoleEchoDedup echoes;
    private final AtomicReference<Sink> sink = new AtomicReference<>();
    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();
    private final AtomicLong ids = new AtomicLong();
    private final AtomicBoolean installed = new AtomicBoolean();

    /** Production: one daemon thread forgets pending requests at {@link #BORROW_MS}. */
    private LogFilterBridge() {
        this(new DaemonScheduler(), System::currentTimeMillis);
    }

    /** Tests pass a scheduler they fire themselves. */
    LogFilterBridge(@NonNull final Scheduler scheduler) {
        this(scheduler, System::currentTimeMillis);
    }

    /** Tests pass a clock so an echo claim can expire without waiting. */
    LogFilterBridge(@NonNull final Scheduler scheduler, @NonNull final ConsoleEchoDedup.Clock clock) {
        this.scheduler = scheduler;
        this.echoes = new ConsoleEchoDedup(clock);
    }

    private final EventFilter<LogEvent> filter = new EventFilter<LogEvent>() {
        @Override
        public void filter(
                @NonNull final LogEvent event,
                @NonNull final Callback1<LogEvent> callback
        ) {
            try {
                route(event, callback);
            } catch (final Throwable e) {
                // The SDK rethrows a filter exception, which on the wrapper
                // channel's thread is a crash. Drop the line instead.
                drop(callback);
            }
        }
    };

    void attach(@NonNull final Sink next) {
        sink.set(next);
    }

    /**
     * Drops every request this sink was asked. A reload can attach the new
     * module first; the sink is cleared only when {@code current} is still
     * it, but {@code current}'s pending entries are always removed. The
     * callback is run with {@code null} only while the entry is still the
     * SDK's live borrow. After the entry has been recycled, the pending is
     * forgotten and the callback is not touched.
     */
    void detach(@NonNull final Sink current) {
        sink.compareAndSet(current, null);
        final List<Pending> owned = new ArrayList<>();
        for (final Pending item : pending.values()) {
            if (item.owner == current && pending.remove(item.id, item)) {
                owned.add(item);
            }
        }
        for (final Pending item : owned) {
            cancel(item.deadline);
            if (stillBorrowed(item)) {
                drop(item.callback);
            }
        }
    }

    /** Installs the filter, or removes it. A second {@code true} is a no-op. */
    void setEnabled(final boolean enabled) {
        if (enabled) {
            if (installed.compareAndSet(false, true)) {
                Bugsee.setLogEventFilter(filter);
            }
            return;
        }
        if (installed.compareAndSet(true, false)) {
            Bugsee.setLogEventFilter(null);
        }
    }

    /**
     * Applies JS's answer. {@code null} drops the line, while the entry is
     * still the one the SDK lent us. A string is written onto that event and
     * the same event is returned, so the level and the timestamp stay. If
     * the event ignores {@code setMessage} (the interface default is a
     * no-op), the line is dropped rather than kept unredacted.
     *
     * <p>If {@code getMessage()} is no longer the original line, the pooled
     * entry has been recycled. This returns without {@code setMessage} and
     * without {@code callback.run}: either would land on whatever line owns
     * the entry now.
     */
    void reply(@NonNull final String requestId, @Nullable final String line) {
        final Pending item = pending.remove(requestId);
        if (item == null) {
            return;
        }
        cancel(item.deadline);
        if (!stillBorrowed(item)) {
            return;
        }
        if (line == null) {
            drop(item.callback);
            return;
        }
        item.event.setMessage(line);
        if (!line.equals(item.event.getMessage())) {
            drop(item.callback);
            return;
        }
        item.callback.run(item.event);
    }

    /**
     * One log event from the SDK. A logcat line tagged {@code ReactNativeJS}
     * whose text matches a wrapper-channel line noted moments ago is the
     * console echo: it is dropped here, before {@link #ask} tells JS, so the
     * user's filter runs once. Every other line, including the channel line
     * itself and an RN-internal logcat line, is asked as before.
     */
    void route(
            @NonNull final LogEvent event,
            @NonNull final Callback1<LogEvent> callback
    ) {
        if (echoes.dropEcho(event.getLogSource(), event.getTag(), event.getMessage())) {
            drop(callback);
            return;
        }
        if (event.getLogSource() == LogSource.Custom) {
            echoes.note(event.getMessage());
        }
        ask(event, callback);
    }

    void ask(
            @NonNull final LogEvent event,
            @NonNull final Callback1<LogEvent> callback
    ) {
        final String line = event.getMessage();
        final Sink current = sink.get();
        if (line == null || current == null) {
            drop(callback);
            return;
        }
        final String id = Long.toString(ids.incrementAndGet());
        final Pending item = new Pending(id, event, line, callback, current);
        pending.put(id, item);
        try {
            item.deadline = scheduler.schedule(() -> forget(id), BORROW_MS);
            current.onLogFilterRequest(id, line);
        } catch (final Throwable e) {
            if (pending.remove(id, item)) {
                cancel(item.deadline);
                drop(callback);
            }
        }
    }

    /**
     * The SDK has recycled the entry, or is about to. Forget the request and
     * do not call the callback: calling it would pass the original line
     * through, or touch an entry that now belongs to another line.
     */
    private void forget(@NonNull final String id) {
        pending.remove(id);
    }

    /** The entry is still the SDK's borrow of the line we were asked to filter. */
    private static boolean stillBorrowed(@NonNull final Pending item) {
        try {
            return item.original.equals(item.event.getMessage());
        } catch (final Throwable ignored) {
            return false;
        }
    }

    private static void cancel(@Nullable final Cancellable deadline) {
        if (deadline == null) {
            return;
        }
        try {
            deadline.cancel();
        } catch (final Throwable ignored) {
            // A timer that cannot be cancelled still only forgets the pending.
        }
    }

    private static void drop(@NonNull final Callback1<LogEvent> callback) {
        try {
            callback.run(null);
        } catch (final Throwable ignored) {
            // The SDK already treats a throw from the callback as a drop.
        }
    }

    /** One daemon thread, started on first use, for every request's deadline. */
    private static final class DaemonScheduler implements Scheduler {
        private final ScheduledThreadPoolExecutor executor;

        DaemonScheduler() {
            executor = new ScheduledThreadPoolExecutor(1, runnable -> {
                final Thread thread = new Thread(runnable, "BugseeRN-LogFilterDeadline");
                thread.setDaemon(true);
                return thread;
            });
            executor.setRemoveOnCancelPolicy(true);
        }

        @Override
        @NonNull
        public Cancellable schedule(@NonNull final Runnable task, final long delayMs) {
            final ScheduledFuture<?> future = executor.schedule(task, delayMs, TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        }
    }
}
