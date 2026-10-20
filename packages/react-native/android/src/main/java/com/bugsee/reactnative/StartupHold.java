package com.bugsee.reactnative;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/**
 * The opt-in that closes the window in which an auto-launched SDK records
 * before JavaScript has installed the app's filters.
 *
 * <p>Under manifest auto-launch the SDK starts at process start, long before a
 * JS runtime exists. The JS log, network and breadcrumb filters are installed
 * natively only when {@code setLogFilter} / {@code setNetworkFilter} /
 * {@code setBreadcrumbFilter} run, so everything captured until then is
 * recorded unfiltered. The Android SDK keeps a filter set before launch and
 * applies it to the providers when they are created, so the wrapper's init
 * provider can install the bridge filters first. Each bridge's filter drops an
 * event while no module (or a module whose JS has not answered) is there to
 * ask: fail closed.
 *
 * <p>Opt-in, per filter, by the {@value #META_DATA} manifest meta-data (the
 * Expo plugin's {@code holdFilters} option): a held filter also drops
 * everything for an app that never calls its {@code setXFilter}, so the
 * default is not to hold. JS releases a hold by calling the setter, with a
 * function or with {@code null} (no filter, pass-through).
 */
final class StartupHold {

    static final String META_DATA = "com.bugsee.reactnative.hold-filters";
    static final String NETWORK = "network";
    static final String LOG = "log";
    static final String BREADCRUMB = "breadcrumb";

    private static final String TAG = "BugseeRN";

    private StartupHold() {
    }

    /** How long after a module attaches a hold may wait for JS before the watchdog says so. */
    static final long WATCHDOG_MS = 30_000L;

    /** Which holds JS has not released yet. */
    interface Probe {
        boolean networkHeld();

        boolean logHeld();

        boolean breadcrumbHeld();
    }

    /** Runs a task once, after a delay. Injectable so tests control time. */
    interface Delayer {
        void runAfter(long delayMs, @NonNull Runnable task);
    }

    /** The holds {@code apply} puts in place. */
    interface Targets {
        void holdNetwork();

        void holdLog();

        void holdBreadcrumb();
    }

    /** The real probe. */
    static final Probe PROBE = new Probe() {
        @Override
        public boolean networkHeld() {
            return NetworkFilterBridge.shared().isHeld();
        }

        @Override
        public boolean logHeld() {
            return LogFilterBridge.shared().isHeld();
        }

        @Override
        public boolean breadcrumbHeld() {
            return BreadcrumbFilterBridge.shared().isHeld();
        }
    };

    private static final java.util.concurrent.atomic.AtomicBoolean WATCHING =
            new java.util.concurrent.atomic.AtomicBoolean();

    /** The real bridges. */
    static final Targets BRIDGES = new Targets() {
        @Override
        public void holdNetwork() {
            NetworkFilterBridge.shared().holdUntilJs();
        }

        @Override
        public void holdLog() {
            LogFilterBridge.shared().holdUntilJs();
        }

        @Override
        public void holdBreadcrumb() {
            BreadcrumbFilterBridge.shared().holdUntilJs();
        }
    };

    /**
     * The filters {@code raw} names: a comma list of {@link #NETWORK},
     * {@link #LOG} and {@link #BREADCRUMB}, or {@code all} / {@code true} for
     * all three. Case and spaces do not matter. A name that is not one of
     * them is ignored, since a typo that held nothing is no worse than the
     * default, but one that threw would kill the process at start.
     */
    @NonNull
    static Set<String> parse(@Nullable final Object raw) {
        if (raw == null) {
            return Collections.emptySet();
        }
        final Set<String> held = new LinkedHashSet<>();
        for (final String part : raw.toString().split(",")) {
            final String name = part.trim().toLowerCase(Locale.ROOT);
            if (name.equals("all") || name.equals("true")) {
                held.add(NETWORK);
                held.add(LOG);
                held.add(BREADCRUMB);
            } else if (name.equals(NETWORK) || name.equals(LOG) || name.equals(BREADCRUMB)) {
                held.add(name);
            }
        }
        return held;
    }

    /**
     * Holds each filter {@code raw} names. One that fails to hold does not
     * stop the others: the rest still close their window. Returns what was
     * held. Never throws, errors included; see
     * {@link ReactNativeWrapperInitProvider#registerEarly}.
     */
    @NonNull
    static Set<String> apply(@Nullable final Object raw, @NonNull final Targets targets) {
        final Set<String> held = new LinkedHashSet<>();
        for (final String name : parse(raw)) {
            try {
                if (name.equals(NETWORK)) {
                    targets.holdNetwork();
                } else if (name.equals(LOG)) {
                    targets.holdLog();
                } else {
                    targets.holdBreadcrumb();
                }
                held.add(name);
            } catch (Throwable t) {
                Log.e(TAG, "could not hold the " + name + " filter at process start: "
                        + t.getClass().getName());
            }
        }
        if (!held.isEmpty()) {
            Log.i(TAG, "holding the " + held + " filter(s) from process start: events are dropped until JS calls "
                    + "setNetworkFilter / setLogFilter / setBreadcrumbFilter (a function, or null for none)");
        }
        return held;
    }

    /**
     * The filters {@code probe} says JS has not released, in a fixed order.
     */
    @NonNull
    static Set<String> stillHeld(@NonNull final Probe probe) {
        final Set<String> waiting = new LinkedHashSet<>();
        if (probe.networkHeld()) {
            waiting.add(NETWORK);
        }
        if (probe.logHeld()) {
            waiting.add(LOG);
        }
        if (probe.breadcrumbHeld()) {
            waiting.add(BREADCRUMB);
        }
        return waiting;
    }

    /**
     * Once per process, {@code delayMs} after the first module attaches: says so
     * (and returns what, to the log) if a filter is still held, because an
     * app that lists a filter and never calls its setter records none of that
     * kind. A log line only; it changes no behaviour.
     *
     * @return whether this call scheduled the watchdog
     */
    static boolean watch(
            @NonNull final Probe probe,
            @NonNull final Delayer delayer,
            @NonNull final java.util.function.Consumer<String> warn,
            final long delayMs
    ) {
        if (!WATCHING.compareAndSet(false, true)) {
            return false;
        }
        delayer.runAfter(delayMs, () -> {
            final Set<String> waiting = stillHeld(probe);
            if (!waiting.isEmpty()) {
                warn.accept("the " + waiting + " filter(s) are still held " + (delayMs / 1000L)
                        + " s after the JS runtime started: events of that kind are being dropped. Call "
                        + "setNetworkFilter / setLogFilter / setBreadcrumbFilter at startup (null for no filter), "
                        + "or remove it from holdFilters");
            }
        });
        return true;
    }

    /** What a module does once its bridges are attached: start the watchdog if a hold is still on. */
    static void watchFromModule() {
        try {
            if (stillHeld(PROBE).isEmpty()) {
                return;
            }
            final Handler main = new Handler(Looper.getMainLooper());
            watch(PROBE, (delayMs, task) -> main.postDelayed(task, delayMs), message -> Log.w(TAG, message), WATCHDOG_MS);
        } catch (Throwable t) {
            Log.e(TAG, "could not start the startup hold watchdog: " + t.getClass().getName());
        }
    }

    /** Test seam: lets another test start a fresh watchdog. */
    static void resetWatchForTest() {
        WATCHING.set(false);
    }
}
