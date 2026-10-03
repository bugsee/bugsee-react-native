package com.bugsee.reactnative;

import androidx.annotation.Nullable;

import com.bugsee.library.contracts.performance.SpanStatus;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The spans the bridge is holding onto.
 *
 * <p>A span is an object with a lifetime. The registry is the strong
 * reference that would leak it: {@link #finish} calls through to the span
 * and then drops every entry whose span is now finished, including a child
 * a parent finish cancelled. {@link #size} and {@link #contains} are what
 * the tests assert, so a finish that forgets to remove the entry fails them.
 */
final class SpanHandles {

    /** What the registry needs from a span. The module adapts the SDK's {@code Span}. */
    interface Retained {
        /** {@code status} null is the no-arg {@code finish}. */
        void finish(@Nullable SpanStatus status);

        boolean isFinished();
    }

    private static final class Entry {
        final Object identity;
        final Retained retained;

        Entry(final Object identity, final Retained retained) {
            this.identity = identity;
            this.retained = retained;
        }
    }

    private final Map<String, Entry> byHandle = new LinkedHashMap<>();
    private final Map<Object, String> byIdentity = new IdentityHashMap<>();
    private int next = 1;

    /**
     * Holds {@code retained} for {@code identity}. The same identity returns
     * the handle already issued and does not store {@code retained} again.
     * A null identity is not a span: the map would reject it, and nothing is
     * stored. Synchronized like {@code CreatedReports}: {@code invalidate}
     * calls {@link #releaseAll} on another thread.
     */
    synchronized String retain(@Nullable final Object identity, @Nullable final Retained retained) {
        if (identity == null || retained == null) {
            return "";
        }
        final String existing = byIdentity.get(identity);
        if (existing != null) {
            return existing;
        }
        final String handle = "sp-" + next;
        next += 1;
        byHandle.put(handle, new Entry(identity, retained));
        byIdentity.put(identity, handle);
        return handle;
    }

    /**
     * Finishes {@code handle}, then drops that handle even when
     * {@code isFinished()} is still false (a no-op span can leave the flag
     * down). Other retained spans are dropped only when they now report
     * finished. Empty when {@code handle} is not held.
     */
    synchronized List<String> finish(final String handle, @Nullable final SpanStatus status) {
        final Entry entry = byHandle.get(handle);
        if (entry == null) {
            return Collections.emptyList();
        }
        entry.retained.finish(status);
        return releaseFinished(handle);
    }

    /** Drops every handle. Does not finish the spans. Used when the module goes away. */
    synchronized void releaseAll() {
        byHandle.clear();
        byIdentity.clear();
    }

    synchronized boolean contains(final String handle) {
        return byHandle.containsKey(handle);
    }

    synchronized int size() {
        return byHandle.size();
    }

    @Nullable
    synchronized Retained get(final String handle) {
        final Entry entry = byHandle.get(handle);
        return entry == null ? null : entry.retained;
    }

    /**
     * The SDK status for a wire integer, or null when it is outside the
     * enum. The integer is the ordinal: Android's {@code SpanStatus} has no
     * separate value, and iOS declares the same numbers from 0.
     */
    @Nullable
    static SpanStatus status(final int wire) {
        final SpanStatus[] values = SpanStatus.values();
        if (wire < 0 || wire >= values.length) {
            return null;
        }
        final SpanStatus status = values[wire];
        if (status.ordinal() != wire) {
            return null;
        }
        return status;
    }

    /** Caller holds the lock. {@code called} is removed whether or not it reports finished. */
    private List<String> releaseFinished(final String called) {
        final List<String> released = new ArrayList<>();
        final Entry calledEntry = byHandle.remove(called);
        if (calledEntry != null) {
            byIdentity.remove(calledEntry.identity);
            released.add(called);
        }
        final Iterator<Map.Entry<String, Entry>> entries = byHandle.entrySet().iterator();
        while (entries.hasNext()) {
            final Map.Entry<String, Entry> entry = entries.next();
            if (!entry.getValue().retained.isFinished()) {
                continue;
            }
            released.add(entry.getKey());
            byIdentity.remove(entry.getValue().identity);
            entries.remove();
        }
        return released;
    }
}
