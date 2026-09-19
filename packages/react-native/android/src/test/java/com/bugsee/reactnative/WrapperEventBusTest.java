package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * The wrapper is registered before React Native exists -- the init provider
 * does it at process start -- so lifecycle events genuinely arrive with no
 * bridge to deliver them to. That is the normal case during start-up, not an
 * error, and it is the reason the sink is separate from the wrapper.
 */
public class WrapperEventBusTest {

    private static final class Recorder implements WrapperEventBus.Sink {
        final List<String> events = new ArrayList<>();

        @Override
        public void onLifecycleEvent(final String name, final String reportId) {
            events.add(name + "/" + reportId);
        }

    }

    private WrapperEventBus bus;

    @Before
    public void setUp() {
        bus = new WrapperEventBus();
    }

    /** Start-up: events before the bridge exists are dropped, not queued. */
    @Test
    public void swallowsEventsWhenNoBridgeIsAttached() {
        bus.emitLifecycle("com.bugsee.lifecycle.Launching", null);
        // Reaching here without throwing is the assertion.
        assertNull(bus.sink());
    }

    @Test
    public void deliversToTheAttachedSink() {
        final Recorder sink = new Recorder();
        bus.attach(sink);

        bus.emitLifecycle("com.bugsee.lifecycle.Launched", null);

        assertEquals(1, sink.events.size());
        assertEquals("Launched/null", sink.events.get(0));
    }

    /**
     * The prefix is stripped here rather than in JS so the wire payload says
     * what the JS type says. Both SDKs dispatch the prefixed form.
     */
    @Test
    public void stripsTheLifecyclePrefix() {
        final Recorder sink = new Recorder();
        bus.attach(sink);

        bus.emitLifecycle("com.bugsee.lifecycle.RelaunchedAfterCrash", null);

        assertEquals("RelaunchedAfterCrash/null", sink.events.get(0));
    }

    /**
     * An unrecognised name is forwarded verbatim rather than dropped. A newer
     * SDK adding an event must not have it silently swallowed by an older
     * wrapper -- that is the failure mode that hides a whole feature.
     */
    @Test
    public void forwardsAnUnprefixedOrUnknownNameUnchanged() {
        final Recorder sink = new Recorder();
        bus.attach(sink);

        bus.emitLifecycle("com.bugsee.lifecycle.SomethingNewIn8x", null);
        bus.emitLifecycle("TotallyUnexpected", null);

        assertEquals("SomethingNewIn8x/null", sink.events.get(0));
        assertEquals("TotallyUnexpected/null", sink.events.get(1));
    }

    /** The report id rides along for the events that carry one. */
    @Test
    public void passesTheReportIdWhenTheEventCarriesOne() {
        final Recorder sink = new Recorder();
        bus.attach(sink);

        bus.emitLifecycle("com.bugsee.lifecycle.AfterReportUploaded", "abc-123");

        assertEquals("AfterReportUploaded/abc-123", sink.events.get(0));
    }

    /**
     * Teardown must stop delivery. A reloaded bridge leaves the old module
     * unusable, and emitting into it is the classic React Native leak.
     */
    @Test
    public void stopsDeliveringAfterDetach() {
        final Recorder sink = new Recorder();
        bus.attach(sink);
        bus.detach(sink);

        bus.emitLifecycle("com.bugsee.lifecycle.Launched", null);

        assertTrue(sink.events.isEmpty());
    }

    /**
     * Detach is keyed on identity. A fast reload can attach the new module
     * before the old one is torn down; the old one's detach must not silence
     * the new one.
     */
    @Test
    public void detachingAStaleSinkLeavesTheCurrentOneAttached() {
        final Recorder stale = new Recorder();
        final Recorder current = new Recorder();
        bus.attach(stale);
        bus.attach(current);

        bus.detach(stale);
        bus.emitLifecycle("com.bugsee.lifecycle.Launched", null);

        assertEquals(1, current.events.size());
        assertTrue(stale.events.isEmpty());
    }

    /** A throwing sink must not break the SDK's dispatch. */
    @Test
    public void survivesASinkThatThrows() {
        bus.attach(new WrapperEventBus.Sink() {
            @Override public void onLifecycleEvent(final String n, final String r) {
                throw new IllegalStateException("bridge is gone");
            }
        });

        bus.emitLifecycle("com.bugsee.lifecycle.Launched", null);
    }

    @Test
    public void isSharedAcrossWrapperInstances() {
        assertTrue(WrapperEventBus.shared() == WrapperEventBus.shared());
    }
}
