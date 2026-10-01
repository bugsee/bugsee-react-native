package com.bugsee.reactnative;

import androidx.annotation.Nullable;

import com.bugsee.library.contracts.reporting.Report;

/**
 * The one created report this process may have outstanding.
 *
 * <p>A slot is taken by {@link #reserve()} or {@link #tryReserve()} and held
 * until {@link #fulfil} stores a report, {@link #fulfil} is given null,
 * {@link #take} removes the report, or {@link #clear} drops whatever is
 * there. A second reserve while the slot is taken returns false. Handles are
 * {@code cr-<n>}, numbered from 1 for the life of the process, and are not
 * reused after a take or a clear.
 *
 * <p>{@link #clear()} does not cancel an SDK listener that is already in
 * flight. Each reservation carries a stamp, and {@link #fulfil} ignores any
 * stamp that is not the current one, so that listener cannot store its report
 * into a reservation opened afterwards or free that reservation.
 */
final class CreatedReports {

    private static final CreatedReports SHARED = new CreatedReports();

    /** True from a successful reserve until that reservation is ended. */
    private boolean creating;

    /**
     * Stamp of the open reservation. {@code 0} is never a live stamp: it is
     * what {@link #tryReserve()} returns when busy, and what {@link #clear()}
     * and a finished {@link #fulfil} leave behind so every earlier stamp misses.
     */
    private int currentStamp;

    /** Next stamp to issue. Skips {@code 0}, which means "not admitted". */
    private int nextStamp = 1;

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
        return tryReserve() != 0;
    }

    /**
     * {@code 0} when a report is outstanding or being created. Otherwise the
     * stamp {@link #fulfil} must present to end this reservation.
     */
    synchronized int tryReserve() {
        if (creating || report != null) {
            return 0;
        }
        creating = true;
        currentStamp = nextStamp;
        nextStamp += 1;
        if (nextStamp == 0) {
            nextStamp = 1;
        }
        return currentStamp;
    }

    /**
     * Ends the reservation {@code stamp} names. A report gets {@code cr-<n>}
     * and holds the slot. Null frees the slot and mints nothing. A stamp that
     * is not the current one, including every stamp issued before
     * {@link #clear()}, changes nothing and returns null.
     */
    @Nullable
    synchronized String fulfil(final int stamp, @Nullable final Report created) {
        if (!creating || stamp == 0 || stamp != currentStamp) {
            return null;
        }
        creating = false;
        currentStamp = 0;
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

    /** Drops the slot and makes every stamp issued so far fail {@link #fulfil}. */
    synchronized void clear() {
        creating = false;
        report = null;
        handle = null;
        currentStamp = 0;
    }
}
