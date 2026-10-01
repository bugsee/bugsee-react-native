package com.bugsee.reactnative;

import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * Where {@code Bugsee.logException} and {@code logUnhandledException} run.
 *
 * <p>Android 7.3.0 blocks the caller for the view hierarchy. That caller must
 * not be the React Native modules thread, or the hierarchy request cannot be
 * answered. Handled and unhandled do not share a queue: JS waits at most
 * 1500 ms for an unhandled report, and a handled backlog on one thread would
 * spend that wait before the fatal call starts.
 */
final class ExceptionExecutors {

    /** Handled reports. A backlog here must not delay {@link #UNHANDLED}. */
    static final Executor HANDLED = singleThread("BugseeRN-exceptions");

    /** Fatal reports. Starts even while {@link #HANDLED} is blocked in the SDK. */
    static final Executor UNHANDLED = singleThread("BugseeRN-fatal");

    private ExceptionExecutors() {
    }

    private static Executor singleThread(final String name) {
        return Executors.newSingleThreadExecutor(r -> {
            final Thread thread = new Thread(r, name);
            thread.setDaemon(true);
            return thread;
        });
    }
}
