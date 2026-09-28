package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import android.util.Log;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.options.Options;
import com.bugsee.library.contracts.reporting.Report;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Routes the SDK's report callbacks to JS and back, through a table of
 * opaque handles.
 *
 * <p>Every dispatch ends in exactly one run of the SDK's completion, whichever
 * gets there first: JS completing the handle, the handle's deadline, the
 * bridge detaching (a reload), or a failure to reach JS at all. The guard is
 * one {@link AtomicBoolean} per handle; everything else -- the table, the
 * timer -- is bookkeeping that may race freely behind it.
 *
 * <p>Like {@link WrapperEventBus}, this outlives any one React instance: the
 * wrapper that calls in is registered at process start, while the module that
 * receives comes and goes with the JS runtime.
 */
final class ReportHandlerBridge {

    private static final String TAG = "BugseeRN";

    enum Phase {
        BEFORE("before"),
        AFTER("after");

        final String wire;

        Phase(final String wire) {
            this.wire = wire;
        }
    }

    /** What the module implements to emit {@code onReportHandlerRequest}. */
    interface Sink {
        void onReportHandlerRequest(
                String handleId,
                String phase,
                String reportId,
                String type,
                double deadlineMs);
    }

    interface Cancellable {
        void cancel();
    }

    /** Arms a handle's deadline. Injectable so tests control time. */
    interface Scheduler {
        Cancellable schedule(Runnable task, long delayMs);
    }

    /** Its own interface: {@code java.util.function} needs API 24, minSdk is 21. */
    interface LiveDeadlineSource {
        long liveMs();
    }

    private static final class Handle {
        final String id;
        final Report report;
        final Runnable sdkCompletion;
        /** The sink this handle was emitted to; its detach completes it. */
        final Sink owner;
        /** The exactly-once guard. Whoever flips it runs the completion. */
        final AtomicBoolean done = new AtomicBoolean();
        volatile Cancellable timer;

        Handle(final String id, final Report report, final Runnable sdkCompletion, final Sink owner) {
            this.id = id;
            this.report = report;
            this.sdkCompletion = sdkCompletion;
            this.owner = owner;
        }
    }

    private static final ReportHandlerBridge SHARED =
            new ReportHandlerBridge(new DaemonScheduler(), ReportHandlerBridge::liveMsFromLaunchOptions);

    @NonNull
    static ReportHandlerBridge shared() {
        return SHARED;
    }

    private final Scheduler scheduler;
    private final LiveDeadlineSource live;
    private final AtomicReference<Sink> sink = new AtomicReference<>();
    private final Map<String, Handle> handles = new ConcurrentHashMap<>();
    private final AtomicLong counter = new AtomicLong();
    private volatile boolean beforeRegistered;
    private volatile boolean afterRegistered;

    ReportHandlerBridge(@NonNull final Scheduler scheduler, @NonNull final LiveDeadlineSource live) {
        this.scheduler = scheduler;
        this.live = live;
    }

    void setPhases(final boolean before, final boolean after) {
        beforeRegistered = before;
        afterRegistered = after;
    }

    /**
     * Attaches the module of a new JS runtime, which has registered no phases
     * yet. Until it does, dispatches complete at once rather than emit to a
     * runtime with no listener, where they would sit until the deadline.
     */
    void attach(@NonNull final Sink newSink) {
        sink.set(newSink);
        setPhases(false, false);
    }

    /**
     * Completes every handle emitted to {@code stale}: nothing in any other JS
     * runtime knows them, so waiting for their deadlines would only delay the
     * reports. Clears the sink and the phases only if {@code stale} is still
     * the attached one -- a fast reload attaches the new module before the old
     * one is invalidated, and an unconditional clear would silence it.
     */
    void detach(@NonNull final Sink stale) {
        if (sink.compareAndSet(stale, null)) {
            setPhases(false, false);
        }
        for (final Handle handle : handles.values()) {
            if (handle.owner == stale) {
                finish(handle, "detach");
            }
        }
    }

    void dispatch(
            @NonNull final Phase phase,
            @NonNull final Report report,
            final boolean isTerminating,
            @NonNull final Runnable sdkCompletion
    ) {
        // The process dies when this returns; nothing asynchronous survives.
        if (isTerminating) {
            completeUnminted(phase, report, sdkCompletion, "terminating");
            return;
        }
        final Sink target = sink.get();
        final boolean registered = phase == Phase.BEFORE ? beforeRegistered : afterRegistered;
        if (target == null || !registered) {
            completeUnminted(phase, report, sdkCompletion, "no-handler");
            return;
        }
        final long deadlineMs = ReportHandlerDeadlines.forThread(
                Thread.currentThread().getName(), live.liveMs());
        if (deadlineMs < ReportHandlerDeadlines.MIN_USEFUL_DEADLINE_MS) {
            completeUnminted(phase, report, sdkCompletion, "no-handler");
            return;
        }

        final Handle handle = new Handle(
                "rh-" + counter.incrementAndGet(), report, sdkCompletion, target);
        handles.put(handle.id, handle);
        try {
            // The task holds the handle itself, not its id: a deadline that
            // was already running when JS completed must still hit the guard.
            final Cancellable timer = scheduler.schedule(() -> finish(handle, "deadline"), deadlineMs);
            handle.timer = timer;
            if (handle.done.get()) {
                // Finished between put and here; don't leave the timer armed.
                cancelQuietly(timer);
            }
            Log.i(TAG, "report handler " + handle.id + " phase=" + phase.wire
                    + " deadline=" + deadlineMs);
            target.onReportHandlerRequest(
                    handle.id, phase.wire, report.getId(), ReportOps.typeOf(report), deadlineMs);
        } catch (final Throwable e) {
            // A dead bridge throws from the emit, on the SDK's thread. JS will
            // never answer, so answer for it now.
            Log.w(TAG, "report handler " + handle.id + " could not reach JS", e);
            finish(handle, "no-handler");
        }
    }

    /** @return true only for the call that ran the SDK completion. */
    boolean complete(@NonNull final String handleId) {
        final Handle handle = handles.get(handleId);
        return handle != null && finish(handle, "js");
    }

    /** The live report behind {@code handleId}, or null once it is completed. */
    @Nullable
    Report reportFor(@NonNull final String handleId) {
        final Handle handle = handles.get(handleId);
        return handle == null || handle.done.get() ? null : handle.report;
    }

    private boolean finish(@NonNull final Handle handle, @NonNull final String by) {
        if (!handle.done.compareAndSet(false, true)) {
            return false;
        }
        handles.remove(handle.id, handle);
        final Cancellable timer = handle.timer;
        if (timer != null) {
            cancelQuietly(timer);
        }
        Log.i(TAG, "report handler " + handle.id + " completed by=" + by);
        runQuietly(handle.sdkCompletion);
        return true;
    }

    /** No handle was minted; the line still carries the report for correlation. */
    private static void completeUnminted(
            @NonNull final Phase phase,
            @NonNull final Report report,
            @NonNull final Runnable sdkCompletion,
            @NonNull final String by
    ) {
        Log.i(TAG, "report handler - completed by=" + by + " phase=" + phase.wire
                + " report=" + safeId(report));
        runQuietly(sdkCompletion);
    }

    /** The SDK's own fault must not escape into JS's thread or the timer's. */
    private static void runQuietly(@NonNull final Runnable sdkCompletion) {
        try {
            sdkCompletion.run();
        } catch (final Throwable e) {
            Log.w(TAG, "report handler completion threw", e);
        }
    }

    private static void cancelQuietly(@NonNull final Cancellable timer) {
        try {
            timer.cancel();
        } catch (final Throwable e) {
            Log.w(TAG, "report handler timer cancel threw", e);
        }
    }

    @Nullable
    private static String safeId(@NonNull final Report report) {
        try {
            return report.getId();
        } catch (final Throwable e) {
            return null;
        }
    }

    /**
     * The {@code ReportHandlerCallbackTimeout} option in effect, read at each
     * dispatch because a relaunch can change it. Any failure reads as
     * "unknown", which is the default deadline.
     */
    private static long liveMsFromLaunchOptions() {
        Integer seconds = null;
        try {
            final Object value = Bugsee.getLaunchOptions().getOption(Options.ReportHandlerCallbackTimeout);
            if (value instanceof Number) {
                seconds = ((Number) value).intValue();
            }
        } catch (final Throwable e) {
            Log.w(TAG, "could not read the report handler timeout option", e);
        }
        return ReportHandlerDeadlines.liveMs(seconds);
    }

    /** One daemon thread, started on first use, for every handle's deadline. */
    private static final class DaemonScheduler implements Scheduler {
        private final ScheduledThreadPoolExecutor executor;

        DaemonScheduler() {
            executor = new ScheduledThreadPoolExecutor(1, runnable -> {
                final Thread thread = new Thread(runnable, "BugseeRN-ReportDeadline");
                thread.setDaemon(true);
                return thread;
            });
            // A handle completed by JS should not leave 25 s of dead task queued.
            executor.setRemoveOnCancelPolicy(true);
        }

        @Override
        public Cancellable schedule(final Runnable task, final long delayMs) {
            final ScheduledFuture<?> future = executor.schedule(task, delayMs, TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        }
    }
}
