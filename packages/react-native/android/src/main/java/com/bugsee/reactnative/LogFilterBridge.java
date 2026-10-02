package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.common.Callback1;
import com.bugsee.library.contracts.exchange.EventFilter;
import com.bugsee.library.contracts.exchange.LogEvent;

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
 * <p>The native filter stays installed even when the app has no log callback.
 * It drops a classified console echo and returns every other line at once,
 * with no JS round trip. {@link #setEnabled}{@code (false)} does not remove
 * it. While a user callback is installed, a missing sink still drops: that
 * is the redaction boundary. A missing sink with no user callback is the
 * pass-through, and the line is kept.
 *
 * <p>{@link #filter} returns without waiting. The SDK drops a line whose
 * callback is never run, and at 10 seconds recycles the pooled entry. This
 * bridge forgets the pending request at {@link #BORROW_MS}, strictly earlier,
 * without calling the callback. A recycled entry can carry the same text, so
 * a reply that still sees the original message must not {@code setMessage}
 * or {@code callback.run} once that deadline has passed. A missing sink
 * while the user filter is installed, a failed emit, or a {@code null} reply
 * while {@code getMessage()} is still the original line and the deadline has
 * not fired pass {@code null} to the SDK, which discards the line. Once the
 * message is no longer that line, the bridge does not call {@code setMessage}
 * or {@code callback.run}.
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

    /** Installs the native filter. Tests install nothing. */
    interface Installer {
        void install(@NonNull EventFilter<LogEvent> filter);
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
    private final Installer installer;
    private final AtomicReference<Sink> sink = new AtomicReference<>();
    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();
    private final AtomicLong ids = new AtomicLong();
    /** True only while the app has a log callback. False is the native pass-through. */
    private final AtomicBoolean userFilter = new AtomicBoolean();

    /** Production: one daemon thread forgets pending requests at {@link #BORROW_MS}. */
    private LogFilterBridge() {
        this(new DaemonScheduler(), System::currentTimeMillis, Bugsee::setLogEventFilter);
    }

    /** Tests pass a scheduler they fire themselves. They do not touch {@link Bugsee}. */
    LogFilterBridge(@NonNull final Scheduler scheduler) {
        this(scheduler, System::currentTimeMillis, filter -> { });
    }

    /** Tests pass a clock so an echo claim can expire without waiting. */
    LogFilterBridge(@NonNull final Scheduler scheduler, @NonNull final ConsoleEchoDedup.Clock clock) {
        this(scheduler, clock, filter -> { });
    }

    private LogFilterBridge(
            @NonNull final Scheduler scheduler,
            @NonNull final ConsoleEchoDedup.Clock clock,
            @NonNull final Installer installer
    ) {
        this.scheduler = scheduler;
        this.echoes = new ConsoleEchoDedup(clock);
        this.installer = installer;
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

    /**
     * Turns the JS round trip on or off. The native filter stays installed
     * either way: off is the pass-through, which drops an echo and returns
     * every other line. It does not pass {@code null} to
     * {@link Bugsee#setLogEventFilter}.
     */
    void setEnabled(final boolean enabled) {
        userFilter.set(enabled);
        ensureInstalled();
    }

    /**
     * Puts the native filter back if a launch replaced it. Does not change
     * whether the user callback is asked.
     */
    void ensureInstalled() {
        installer.install(filter);
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
     * The console patch calls this before the original hook writes logcat.
     * A later {@code ReactNativeJS} line with this text is the echo and is
     * dropped in {@link #route}. A {@code Bugsee.log} of the same text is
     * {@code Custom} and does not arm another drop.
     */
    void noteEcho(@Nullable final String message) {
        echoes.note(message);
    }

    /**
     * One log event from the SDK. A logcat line tagged {@code ReactNativeJS}
     * whose text was noted by {@link #noteEcho} is the console echo: it is
     * dropped here, before JS is asked, so the user's filter runs once. The
     * credit is consumed. With no user callback, every other line is returned
     * immediately. With a user callback, those lines are asked. A missing
     * sink on that path still drops.
     */
    void route(
            @NonNull final LogEvent event,
            @NonNull final Callback1<LogEvent> callback
    ) {
        if (echoes.dropEcho(event.getLogSource(), event.getTag(), event.getMessage())) {
            drop(callback);
            return;
        }
        if (!userFilter.get()) {
            keep(callback, event);
            return;
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

    /** The native pass-through. The line is kept. This is not a drop. */
    private static void keep(
            @NonNull final Callback1<LogEvent> callback,
            @NonNull final LogEvent event
    ) {
        try {
            callback.run(event);
        } catch (final Throwable ignored) {
            // The SDK already has the line. A throw here must not replace it.
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
