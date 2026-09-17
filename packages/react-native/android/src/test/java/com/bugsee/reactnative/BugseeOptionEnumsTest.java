package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.contracts.options.FrameRate;
import com.bugsee.library.contracts.options.IssueSeverity;
import com.bugsee.library.contracts.options.LogLevel;
import com.bugsee.library.contracts.options.VideoMode;
import com.bugsee.library.contracts.options.VideoQuality;

import org.junit.Test;

/**
 * Numbers cross the bridge as the enum's INTERNAL VALUE, never its ordinal.
 *
 * <p>The two diverge on four of the five option enums, so a table built on
 * {@code values()[n]} is wrong in a way nothing at runtime reports: the SDK
 * receives a valid but different enum constant and honours it.
 */
public class BugseeOptionEnumsTest {

    /** Error is value 1 but ordinal 0, so values()[1] would yield Warning. */
    @Test
    public void logLevelIsReadByValueNotOrdinal() {
        assertEquals(LogLevel.Error, BugseeOptionEnums.coerce(
                "com.bugsee.option.capture.logs.level", 1));
        assertEquals(1, LogLevel.Error.ordinal() + 1);
        assertEquals(LogLevel.Warning, LogLevel.values()[1]);
    }

    /** Fullscreen is value 20 but ordinal 3; values()[20] would not exist. */
    @Test
    public void videoModeIsReadByValueNotOrdinal() {
        assertEquals(VideoMode.Fullscreen, BugseeOptionEnums.coerce(
                "com.bugsee.option.capture.video.mode", 20));
        assertEquals(3, VideoMode.Fullscreen.ordinal());
        assertTrue(VideoMode.values().length < 20);
    }

    @Test
    public void frameRateIsReadByValue() {
        assertEquals(FrameRate.Low, BugseeOptionEnums.coerce(
                "com.bugsee.option.capture.video.frame-rate", 1));
        assertEquals(FrameRate.Medium, FrameRate.values()[1]);
    }

    @Test
    public void issueSeverityIsReadByValue() {
        assertEquals(IssueSeverity.VeryLow, BugseeOptionEnums.coerce(
                "com.bugsee.option.reporting.defaults.crash-priority", 1));
        assertEquals(IssueSeverity.Blocker, BugseeOptionEnums.coerce(
                "com.bugsee.option.reporting.defaults.bug-priority", 5));
    }

    /** The one enum whose values and ordinals coincide, so it proves nothing
     *  on its own -- included so a regression here is still caught. */
    @Test
    public void videoQualityCoincidesButIsStillReadByValue() {
        assertEquals(VideoQuality.High, BugseeOptionEnums.coerce(
                "com.bugsee.option.capture.video.quality", 2));
    }

    @Test
    public void everyIssueSeverityKeyIsCoerced() {
        for (final String key : new String[] {
                "com.bugsee.option.reporting.defaults.crash-priority",
                "com.bugsee.option.reporting.defaults.error-priority",
                "com.bugsee.option.reporting.defaults.bug-priority",
        }) {
            assertEquals("key " + key, IssueSeverity.High,
                    BugseeOptionEnums.coerce(key, 3));
        }
    }

    /** A key with no enum type is not this table's business. */
    @Test
    public void leavesNonEnumKeysAlone() {
        assertNull(BugseeOptionEnums.coerce("com.bugsee.option.capture.logs", 1));
        assertNull(BugseeOptionEnums.coerce("com.bugsee.option.invented.later", 1));
    }

    /**
     * An out-of-range number yields null rather than a nearby constant. The
     * SDK then applies its own default, which is the right outcome for a
     * value the wrapper cannot interpret.
     */
    @Test
    public void refusesAValueNoConstantCarries() {
        assertNull(BugseeOptionEnums.coerce(
                "com.bugsee.option.capture.video.mode", 99));
        assertNull(BugseeOptionEnums.coerce(
                "com.bugsee.option.capture.logs.level", 0));
    }

    @Test
    public void numberForPassesScalarsThroughUntouched() {
        assertEquals(1.0, BugseeOptionEnums.numberFor(
                "com.bugsee.option.config.duration", 1.0));
        assertEquals(60.0, BugseeOptionEnums.numberFor(
                "com.bugsee.option.config.duration", 60.0));
    }

    @Test
    public void numberForCoercesAnEnumKey() {
        assertEquals(VideoMode.Fullscreen, BugseeOptionEnums.numberFor(
                "com.bugsee.option.capture.video.mode", 20.0));
    }

    /**
     * JS has one number type, so everything arrives as a double. A
     * non-integer names no constant, and truncating it would silently pick
     * one -- 20.9 is not Fullscreen.
     */
    @Test
    public void numberForRefusesANonIntegerEnumValue() {
        assertNull(BugseeOptionEnums.numberFor(
                "com.bugsee.option.capture.video.mode", 20.9));
        assertNull(BugseeOptionEnums.numberFor(
                "com.bugsee.option.capture.video.mode", Double.NaN));
        assertNull(BugseeOptionEnums.numberFor(
                "com.bugsee.option.capture.video.mode", Double.POSITIVE_INFINITY));
    }

    @Test
    public void knowsExactlyTheEnumTypedKeys() {
        assertEquals(7, BugseeOptionEnums.enumKeys().size());
    }
}
