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
 * callback is never run (its own timeout, on Android); this bridge does not
 * add another one, and it never answers with the original line when it cannot
 * deliver a replacement. A missing sink, a failed emit, or a {@code null}
 * reply all pass {@code null} to the SDK, which discards the line.
 */
final class LogFilterBridge {

    /** What the module implements to emit {@code onLogFilterRequest}. */
    interface Sink {
        void onLogFilterRequest(@NonNull String requestId, @NonNull String line);
    }

    private static final class Pending {
        @NonNull final String id;
        @NonNull final LogEvent event;
        @NonNull final Callback1<LogEvent> callback;
        @NonNull final Sink owner;

        Pending(
                @NonNull final String id,
                @NonNull final LogEvent event,
                @NonNull final Callback1<LogEvent> callback,
                @NonNull final Sink owner
        ) {
            this.id = id;
            this.event = event;
            this.callback = callback;
            this.owner = owner;
        }
    }

    private static final LogFilterBridge SHARED = new LogFilterBridge();

    @NonNull
    static LogFilterBridge shared() {
        return SHARED;
    }

    private final AtomicReference<Sink> sink = new AtomicReference<>();
    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();
    private final AtomicLong ids = new AtomicLong();
    private final AtomicBoolean installed = new AtomicBoolean();

    private final EventFilter<LogEvent> filter = new EventFilter<LogEvent>() {
        @Override
        public void filter(
                @NonNull final LogEvent event,
                @NonNull final Callback1<LogEvent> callback
        ) {
            try {
                ask(event, callback);
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
     * Drops every request this sink was asked, then forgets it. A reload can
     * attach the new module first; only {@code current}'s requests are
     * answered, and only when it is still the sink.
     */
    void detach(@NonNull final Sink current) {
        if (!sink.compareAndSet(current, null)) {
            return;
        }
        final List<Pending> owned = new ArrayList<>();
        for (final Pending item : pending.values()) {
            if (item.owner == current && pending.remove(item.id, item)) {
                owned.add(item);
            }
        }
        for (final Pending item : owned) {
            drop(item.callback);
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
     * Applies JS's answer. {@code null} drops the line. A string is written
     * onto the event the SDK handed us and that same event is returned, so
     * the level and the timestamp stay. If the event ignores {@code
     * setMessage} (the interface default is a no-op), the line is dropped
     * rather than kept unredacted.
     */
    void reply(@NonNull final String requestId, @Nullable final String line) {
        final Pending item = pending.remove(requestId);
        if (item == null) {
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

    private void ask(
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
        final Pending item = new Pending(id, event, callback, current);
        pending.put(id, item);
        try {
            current.onLogFilterRequest(id, line);
        } catch (final Throwable e) {
            if (pending.remove(id, item)) {
                drop(callback);
            }
        }
    }

    private static void drop(@NonNull final Callback1<LogEvent> callback) {
        try {
            callback.run(null);
        } catch (final Throwable ignored) {
            // The SDK already treats a throw from the callback as a drop.
        }
    }
}
