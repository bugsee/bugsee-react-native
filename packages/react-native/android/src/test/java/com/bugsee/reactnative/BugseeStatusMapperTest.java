package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.contracts.lifecycle.BugseeStatus;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

/**
 * The JS side has its own Status constants; these pin the mapping between them
 * and the SDK's enum. Getting this wrong is silent — a caller polling for
 * "launched" simply never sees it.
 */
public class BugseeStatusMapperTest {

    @Test
    public void mapsEveryStatusToItsWireNumber() {
        assertEquals(0, BugseeStatusMapper.toWire(BugseeStatus.Stopped));
        assertEquals(1, BugseeStatusMapper.toWire(BugseeStatus.Launching));
        assertEquals(2, BugseeStatusMapper.toWire(BugseeStatus.Launched));
        assertEquals(3, BugseeStatusMapper.toWire(BugseeStatus.Stopping));
    }

    /** A null status is "we could not tell", which is closer to stopped than launched. */
    @Test
    public void mapsNullToStopped() {
        assertEquals(0, BugseeStatusMapper.toWire(null));
        assertFalse(BugseeStatusMapper.isMapped(null));
    }

    /**
     * Distinct states must stay distinguishable. Collapsing two onto one wire
     * number would make a caller unable to tell launching from launched.
     */
    @Test
    public void givesEveryStatusADistinctWireNumber() {
        final Set<Integer> seen = new HashSet<>();
        for (BugseeStatus status : BugseeStatus.values()) {
            assertTrue("duplicate wire number for " + status,
                    seen.add(BugseeStatusMapper.toWire(status)));
        }
    }

    /**
     * Every enum constant must map to something. If the SDK adds a state and
     * nobody updates the mapper, this fails rather than silently reporting the
     * new state as stopped.
     */
    @Test
    public void coversEveryConstantTheSdkDeclares() {
        for (BugseeStatus status : BugseeStatus.values()) {
            assertTrue("unmapped SDK status: " + status,
                    BugseeStatusMapper.isMapped(status));
        }
    }
}
