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
     */
    String retain(final Object identity, final Retained retained) {
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
     * Finishes {@code handle} and releases every retained span that is now
     * finished. Empty when {@code handle} is not held: nothing is released.
     */
    List<String> finish(final String handle, @Nullable final SpanStatus status) {
        final Entry entry = byHandle.get(handle);
        if (entry == null) {
            return Collections.emptyList();
        }
        entry.retained.finish(status);
        return releaseFinished();
    }

    /** Drops every handle. Does not finish the spans. Used when the module goes away. */
    void releaseAll() {
        byHandle.clear();
        byIdentity.clear();
    }

    boolean contains(final String handle) {
        return byHandle.containsKey(handle);
    }

    int size() {
        return byHandle.size();
    }

    @Nullable
    Retained get(final String handle) {
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

    private List<String> releaseFinished() {
        final List<String> released = new ArrayList<>();
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
