package com.bugsee.reactnative;

import androidx.annotation.Nullable;

import com.bugsee.library.contracts.lifecycle.BugseeStatus;

import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;

/**
 * Translates the SDK's lifecycle status into the numbers the JS layer uses.
 *
 * <p>The wire numbers are part of the JS API (`Status` in index.ts) and are
 * shared with the iOS bridge, so they are fixed here rather than derived from
 * the enum's ordinal — an SDK reordering its constants must not silently
 * change what JS sees.
 *
 * <p>One table drives both {@link #toWire} and {@link #isMapped}. An earlier
 * version duplicated the mapping as two switch statements, which meant they
 * could disagree, and meant {@code isMapped} could be stubbed out without any
 * test noticing.
 */
public final class BugseeStatusMapper {

    public static final int STOPPED = 0;
    public static final int LAUNCHING = 1;
    public static final int LAUNCHED = 2;
    public static final int STOPPING = 3;

    private static final Map<BugseeStatus, Integer> WIRE;

    static {
        final EnumMap<BugseeStatus, Integer> wire = new EnumMap<>(BugseeStatus.class);
        wire.put(BugseeStatus.Stopped, STOPPED);
        wire.put(BugseeStatus.Launching, LAUNCHING);
        wire.put(BugseeStatus.Launched, LAUNCHED);
        wire.put(BugseeStatus.Stopping, STOPPING);
        WIRE = Collections.unmodifiableMap(wire);
    }

    private BugseeStatusMapper() {}

    /**
     * @param status the SDK's status, or {@code null} if it could not be read
     * @return the wire number; {@link #STOPPED} when unknown, because "we
     *         cannot tell" is far closer to stopped than to launched, and a
     *         caller waiting to start should keep waiting rather than proceed
     */
    public static int toWire(@Nullable final BugseeStatus status) {
        if (status == null) {
            return STOPPED;
        }
        final Integer mapped = WIRE.get(status);
        return mapped != null ? mapped : STOPPED;
    }

    /**
     * Whether this mapper explicitly handles {@code status}. A test sweeps
     * {@link BugseeStatus#values()} through this so that an SDK adding a state
     * fails the build, rather than quietly surfacing in JS as {@code Stopped}.
     */
    public static boolean isMapped(@Nullable final BugseeStatus status) {
        return status != null && WIRE.containsKey(status);
    }
}
