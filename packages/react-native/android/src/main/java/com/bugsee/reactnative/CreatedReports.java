package com.bugsee.reactnative;

import androidx.annotation.Nullable;

import com.bugsee.library.contracts.reporting.Report;

/**
 * The one created report this process may have outstanding.
 *
 * <p>A slot is taken by {@link #reserve()} and held until {@link #fulfil}
 * stores a report, {@link #fulfil} is given null, {@link #take} removes the
 * report, or {@link #clear} drops whatever is there. A second {@code
 * reserve()} while the slot is taken returns false. Handles are {@code
 * cr-<n>}, numbered from 1 for the life of the process, and are not reused
 * after a take or a clear.
 */
final class CreatedReports {

    private static final CreatedReports SHARED = new CreatedReports();

    /** True from {@link #reserve()} until that reservation is ended. */
    private boolean creating;

    @Nullable
    private Report report;

    @Nullable
    private String handle;

    /** Next suffix. Never reset: a handle is fresh for the process. */
    private int next = 1;

    static CreatedReports shared() {
        return SHARED;
    }

    /** Package-private so a test can build an instance that is not {@link #shared()}. */
    CreatedReports() {
    }

    /** False while a created report is outstanding or being created. */
    synchronized boolean reserve() {
        if (creating || report != null) {
            return false;
        }
        creating = true;
        return true;
    }

    /**
     * Ends a reservation. A report gets {@code cr-<n>} and holds the slot.
     * Null frees the slot and mints nothing. A call that does not end a
     * reservation (there is none, or the report is already held) changes
     * nothing and returns null.
     */
    @Nullable
    synchronized String fulfil(@Nullable final Report created) {
        if (!creating) {
            return null;
        }
        creating = false;
        if (created == null) {
            return null;
        }
        handle = "cr-" + next;
        next += 1;
        report = created;
        return handle;
    }

    @Nullable
    synchronized Report get(final String handleId) {
        if (report != null && handleId != null && handleId.equals(handle)) {
            return report;
        }
        return null;
    }

    /** Removes the report and frees the slot. An unknown handle removes nothing. */
    @Nullable
    synchronized Report take(final String handleId) {
        final Report created = get(handleId);
        if (created == null) {
            return null;
        }
        report = null;
        handle = null;
        return created;
    }

    synchronized void clear() {
        creating = false;
        report = null;
        handle = null;
    }
}
