package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.contracts.exchange.NetworkEvent;
import com.bugsee.library.contracts.internal.BugseeWrapperChannel;
import com.bugsee.library.contracts.internal.LogSource;
import com.bugsee.library.contracts.options.LogLevel;

import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class WrapperChannelHolderTest {

    /** Records every call; throws from {@code log} when told to, like an app's filter can. */
    static final class RecordingChannel implements BugseeWrapperChannel {
        static final class Line {
            final String tag;
            final String message;
            final LogLevel level;
            final LogSource source;

            Line(final String tag, final String message, final LogLevel level, final LogSource source) {
                this.tag = tag;
                this.message = message;
                this.level = level;
                this.source = source;
            }
        }

        final List<Line> lines = new ArrayList<>();
        final List<NetworkEvent> events = new ArrayList<>();
        final List<Boolean> requiresFiltering = new ArrayList<>();
        @Nullable
        RuntimeException throwing;

        @Override
        public void log(
                @Nullable final String tag,
                @Nullable final String message,
                @Nullable final LogLevel level,
                @NonNull final LogSource source
        ) {
            lines.add(new Line(tag, message, level, source));
            if (throwing != null) {
                throw throwing;
            }
        }

        @Override
        public void addNetworkEvent(@Nullable final NetworkEvent networkEvent, final boolean filtering) {
            events.add(networkEvent);
            requiresFiltering.add(filtering);
            if (throwing != null) {
                throw throwing;
            }
        }
    }

    private final List<String> diagnostics = Collections.synchronizedList(new ArrayList<>());
    private final WrapperChannelHolder holder =
            new WrapperChannelHolder((message, error) -> diagnostics.add(message));

    @After
    public void resetTheSharedHolder() {
        WrapperChannelHolder.shared().clear();
    }

    private RecordingChannel attached() {
        final RecordingChannel channel = new RecordingChannel();
        holder.set(channel);
        return channel;
    }

    /**
     * Custom (98) is the only honest attribution for a JS line; leaving it to
     * the SDK would read as Unknown on iOS. The tag is null because iOS drops
     * tags, and a line must look the same on both platforms.
     */
    @Test
    public void logsWithSourceCustomAndNoTag() {
        final RecordingChannel channel = attached();
        holder.log("hello", 3);

        assertEquals(1, channel.lines.size());
        final RecordingChannel.Line line = channel.lines.get(0);
        assertSame(LogSource.Custom, line.source);
        assertEquals(98, line.source.getValue());
        assertNull(line.tag);
        assertEquals("hello", line.message);
    }

    /**
     * By value, never by ordinal: Error is value 1 at ordinal 0, so
     * {@code values()[n]} would shift every level by one.
     */
    @Test
    public void mapsLevelsByValue() {
        final RecordingChannel channel = attached();
        final LogLevel[] expected = {
                LogLevel.Error, LogLevel.Warning, LogLevel.Info, LogLevel.Debug, LogLevel.Verbose,
        };
        for (int wire = 1; wire <= 5; wire++) {
            holder.log("level " + wire, wire);
        }

        assertEquals(5, channel.lines.size());
        for (int i = 0; i < expected.length; i++) {
            assertSame("wire " + (i + 1), expected[i], channel.lines.get(i).level);
        }
    }

    /**
     * JS rejects these before they cross, so reaching here is a bridge bug;
     * the line is still worth keeping, at the neutral level. 257 is the trap
     * in a bare {@code (byte)} cast: it wraps to 1 and would read as Error.
     */
    @Test
    public void outOfRangeLevelBecomesInfo() {
        final RecordingChannel channel = attached();
        final int[] wires = { 0, 6, -1, 257 };
        for (final int wire : wires) {
            holder.log("level " + wire, wire);
        }

        assertEquals(wires.length, channel.lines.size());
        for (int i = 0; i < wires.length; i++) {
            assertSame("wire " + wires[i], LogLevel.Info, channel.lines.get(i).level);
        }
    }

    /** Before registration delivers a channel there is nowhere to send a line. */
    @Test
    public void noChannelIsANoOp() {
        holder.log("nobody listening", 3);
        holder.addNetworkEvent(networkEvent());
        assertTrue(diagnostics.isEmpty());
    }

    /**
     * On Android the app's log filter runs on the calling thread and its
     * exception propagates. That thread is React Native's, where an escaping
     * exception is a crash. Reported once per process: the report is itself a
     * log line that can come back through logcat capture into the same filter.
     */
    @Test
    public void aThrowingFilterDoesNotEscapeAndIsReportedOnce() {
        final RecordingChannel channel = attached();
        channel.throwing = new IllegalStateException("the app's filter is broken");

        holder.log("one", 3);
        holder.log("two", 3);
        holder.log("three", 3);

        assertEquals(3, channel.lines.size());
        assertEquals(1, diagnostics.size());
    }

    /**
     * {@code false} would also skip the SDK's built-in NetworkDataSanitizer,
     * not only the app's filter -- there is no case where our code wants it.
     */
    @Test
    public void networkEventsAlwaysRequireFiltering() {
        final RecordingChannel channel = attached();
        final NetworkEvent event = networkEvent();
        holder.addNetworkEvent(event);

        assertEquals(1, channel.events.size());
        assertSame(event, channel.events.get(0));
        assertEquals(Boolean.TRUE, channel.requiresFiltering.get(0));
    }

    /** The same guard as {@code log}, with its own once-flag: one per producer. */
    @Test
    public void aThrowingNetworkFilterDoesNotEscapeAndIsReportedOnceOnItsOwn() {
        final RecordingChannel channel = attached();
        channel.throwing = new IllegalStateException("the app's network filter is broken");

        holder.log("a line", 3);
        holder.addNetworkEvent(networkEvent());
        holder.addNetworkEvent(networkEvent());

        assertEquals(2, channel.events.size());
        assertEquals("one report for log, one for network", 2, diagnostics.size());
    }

    @Test
    public void clearRetiresTheChannel() {
        final RecordingChannel channel = attached();
        holder.clear();
        holder.log("after clear", 3);
        holder.addNetworkEvent(networkEvent());

        assertTrue(channel.lines.isEmpty());
        assertTrue(channel.events.isEmpty());
    }

    /** A later registration's channel replaces the earlier one. */
    @Test
    public void aNewChannelReplacesTheOld() {
        final RecordingChannel first = attached();
        final RecordingChannel second = attached();
        holder.log("to the current one", 3);

        assertTrue(first.lines.isEmpty());
        assertEquals(1, second.lines.size());
    }

    /**
     * The channel lives in the process-wide holder, not in the wrapper: the
     * wrapper is replaced when setWrapperInfo refines the identity, and a
     * channel held by the old instance would go with it.
     */
    @Test
    public void theWrapperStoresTheChannelItIsHanded() {
        final RecordingChannel channel = new RecordingChannel();
        new BugseeReactNativeWrapper("react_native", "1.2.3", null, Collections.<String, String>emptyMap())
                .onWrapperChannelAvailable(channel);

        WrapperChannelHolder.shared().log("through the wrapper's channel", 2);

        assertEquals(1, channel.lines.size());
        assertSame(LogLevel.Warning, channel.lines.get(0).level);
    }

    private static NetworkEvent networkEvent() {
        return (NetworkEvent) Proxy.newProxyInstance(
                NetworkEvent.class.getClassLoader(),
                new Class<?>[] { NetworkEvent.class },
                (proxy, method, args) -> null);
    }
}
