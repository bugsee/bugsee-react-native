package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * The startup hold runs in an init provider, before {@code Application.onCreate}.
 * It must hold exactly what the manifest names, and never throw.
 */
public class StartupHoldTest {

    private static final class RecordingTargets implements StartupHold.Targets {
        final List<String> calls = new ArrayList<>();
        String failOn;

        private void call(final String name) {
            calls.add(name);
            if (name.equals(failOn)) {
                throw new NoClassDefFoundError("com/bugsee/library/Bugsee");
            }
        }

        @Override
        public void holdNetwork() {
            call("network");
        }

        @Override
        public void holdLog() {
            call("log");
        }

        @Override
        public void holdBreadcrumb() {
            call("breadcrumb");
        }
    }

    @Test
    public void nothingIsHeldWithoutTheMetaData() {
        assertEquals(Collections.emptySet(), StartupHold.parse(null));
        assertEquals(Collections.emptySet(), StartupHold.parse(""));
        assertEquals(Collections.emptySet(), StartupHold.parse(" , "));
        final RecordingTargets targets = new RecordingTargets();
        assertTrue(StartupHold.apply(null, targets).isEmpty());
        assertTrue(targets.calls.isEmpty());
    }

    @Test
    public void aListHoldsOnlyTheFiltersItNames() {
        assertEquals(new LinkedHashSet<>(Arrays.asList("log")), StartupHold.parse("log"));
        assertEquals(new LinkedHashSet<>(Arrays.asList("network", "breadcrumb")),
                StartupHold.parse(" Network , BREADCRUMB,network"));
    }

    @Test
    public void allAndTrueHoldEveryFilter() {
        final LinkedHashSet<String> everything = new LinkedHashSet<>(Arrays.asList("network", "log", "breadcrumb"));
        assertEquals(everything, StartupHold.parse("all"));
        assertEquals(everything, StartupHold.parse("true"));
        assertEquals(everything, StartupHold.parse(Boolean.TRUE));
        assertEquals(Collections.emptySet(), StartupHold.parse(Boolean.FALSE));
    }

    @Test
    public void anUnknownNameIsIgnoredNotFatal() {
        assertEquals(new LinkedHashSet<>(Arrays.asList("log")), StartupHold.parse("logs,log,secure"));
        assertEquals(Collections.emptySet(), StartupHold.parse("logs"));
    }

    @Test
    public void applyHoldsEachNamedFilterOnce() {
        final RecordingTargets targets = new RecordingTargets();

        final java.util.Set<String> held = StartupHold.apply("log,network,log", targets);

        assertEquals(Arrays.asList("log", "network"), targets.calls);
        assertEquals(new LinkedHashSet<>(Arrays.asList("log", "network")), held);
    }

    @Test
    public void aFailingHoldDoesNotStopTheOthersAndIsNotReportedAsHeld() {
        final RecordingTargets targets = new RecordingTargets();
        targets.failOn = "network";

        final java.util.Set<String> held = StartupHold.apply("all", targets);

        assertEquals(Arrays.asList("network", "log", "breadcrumb"), targets.calls);
        assertEquals(new LinkedHashSet<>(Arrays.asList("log", "breadcrumb")), held);
    }

    private static final class FakeProbe implements StartupHold.Probe {
        boolean network;
        boolean log;
        boolean breadcrumb;

        @Override
        public boolean networkHeld() {
            return network;
        }

        @Override
        public boolean logHeld() {
            return log;
        }

        @Override
        public boolean breadcrumbHeld() {
            return breadcrumb;
        }
    }

    @Test
    public void stillHeldListsTheUnreleasedFiltersInAFixedOrder() {
        final FakeProbe probe = new FakeProbe();
        assertTrue(StartupHold.stillHeld(probe).isEmpty());
        probe.breadcrumb = true;
        probe.network = true;
        assertEquals(new LinkedHashSet<>(Arrays.asList("network", "breadcrumb")), StartupHold.stillHeld(probe));
        probe.log = true;
        assertEquals(new LinkedHashSet<>(Arrays.asList("network", "log", "breadcrumb")), StartupHold.stillHeld(probe));
    }

    @Test
    public void theWatchdogWarnsOnceAfterTheDelayOnlyForFiltersStillHeld() {
        StartupHold.resetWatchForTest();
        final FakeProbe probe = new FakeProbe();
        probe.log = true;
        final List<Runnable> scheduled = new ArrayList<>();
        final List<Long> delays = new ArrayList<>();
        final List<String> warnings = new ArrayList<>();

        assertTrue(StartupHold.watch(probe, (delay, task) -> {
            delays.add(delay);
            scheduled.add(task);
        }, warnings::add, 30_000L));
        // A second module (a reload) does not start a second watchdog.
        assertFalse(StartupHold.watch(probe, (delay, task) -> scheduled.add(task), warnings::add, 30_000L));

        assertEquals(Arrays.asList(30_000L), delays);
        assertEquals(1, scheduled.size());
        assertTrue(warnings.isEmpty());
        scheduled.get(0).run();
        assertEquals(1, warnings.size());
        assertTrue(warnings.get(0).contains("[log]"));
        assertTrue(warnings.get(0).contains("30 s"));
        StartupHold.resetWatchForTest();
    }

    @Test
    public void theWatchdogSaysNothingWhenJsReleasedEveryHold() {
        StartupHold.resetWatchForTest();
        final FakeProbe probe = new FakeProbe();
        final List<Runnable> scheduled = new ArrayList<>();
        final List<String> warnings = new ArrayList<>();
        StartupHold.watch(probe, (delay, task) -> scheduled.add(task), warnings::add, 1_000L);

        scheduled.get(0).run();

        assertTrue(warnings.isEmpty());
        StartupHold.resetWatchForTest();
    }
}
