package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.Serializable;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

public class AttributeBridgeTest {

    /** A hand-written fake: {@link AttributeBridge.Sdk} is three methods, not forty. */
    private static final class FakeSdk implements AttributeBridge.Sdk {
        final Map<String, Serializable> memory = new LinkedHashMap<>();
        final Map<String, Serializable> persisted = new LinkedHashMap<>();
        /** When true, {@link #set} is a no-op -- the SDK silently dropped the value. */
        boolean ignoreSet;

        @Override
        public void set(final String name, final Serializable value) {
            if (!ignoreSet) {
                memory.put(name, value);
            }
        }

        @Override
        public Object getInMemory(final String name) {
            return memory.get(name);
        }

        @Override
        public Map<String, Serializable> getPersisted() {
            return persisted;
        }
    }

    // --- numberValue -----------------------------------------------------

    @Test
    public void integralNumbersBecomeLong() {
        assertEquals(Long.valueOf(42L), AttributeBridge.numberValue(42.0));
        assertEquals(Long.valueOf(-7L), AttributeBridge.numberValue(-7.0));
        assertEquals(Long.valueOf(2_147_483_648L), AttributeBridge.numberValue(2147483648.0));
        assertEquals(
                Long.valueOf(9_007_199_254_740_991L),
                AttributeBridge.numberValue(9007199254740991.0));
    }

    @Test
    public void negativeZeroBecomesLongZero() {
        final Serializable value = AttributeBridge.numberValue(-0.0);
        assertEquals(Long.valueOf(0L), value);
        assertTrue(value instanceof Long);
    }

    @Test
    public void fractionalNumbersStayDouble() {
        assertEquals(Double.valueOf(1.5), AttributeBridge.numberValue(1.5));
    }

    @Test
    public void integralBeyondTheSafeRangeStaysDouble() {
        final double huge = Math.pow(2, 60);
        assertEquals(Double.valueOf(huge), AttributeBridge.numberValue(huge));
    }

    // --- setAndVerify ------------------------------------------------------

    @Test
    public void verifiedWhenTheSdkKeepsTheValue() {
        final FakeSdk sdk = new FakeSdk();
        assertTrue(AttributeBridge.setAndVerify(sdk, "n", "value"));
        assertEquals("value", sdk.memory.get("n"));
    }

    @Test
    public void rejectedWhenTheSdkDropsTheValue() {
        final FakeSdk sdk = new FakeSdk();
        sdk.ignoreSet = true;
        assertFalse(AttributeBridge.setAndVerify(sdk, "n", "value"));
    }

    @Test
    public void rejectedWhenTheSdkKeepsAnOlderValue() {
        final FakeSdk sdk = new FakeSdk();
        sdk.memory.put("n", "old");
        sdk.ignoreSet = true;
        assertFalse(AttributeBridge.setAndVerify(sdk, "n", "new"));
        assertEquals("old", sdk.memory.get("n"));
    }

    @Test
    public void verifiedWhenTheSdkKeepsABooleanTrue() {
        final FakeSdk sdk = new FakeSdk();
        assertTrue(AttributeBridge.setAndVerify(sdk, "flag", Boolean.TRUE));
        assertEquals(Boolean.TRUE, sdk.memory.get("flag"));
    }

    @Test
    public void rejectedWhenTheSdkDropsABoolean() {
        final FakeSdk sdk = new FakeSdk();
        sdk.ignoreSet = true;
        assertFalse(AttributeBridge.setAndVerify(sdk, "flag", Boolean.TRUE));
    }

    // --- readable ------------------------------------------------------------

    @Test
    public void readableWidensAFloatExactlyAsTheReportWritesIt() {
        final Map<String, Serializable> persisted = new LinkedHashMap<>();
        persisted.put("f", 0.1f);
        final Map<String, Object> result = AttributeBridge.readable(persisted);
        assertEquals(Double.toString((double) 0.1f), result.get("f").toString());
        assertEquals(Double.valueOf(0.10000000149011612), result.get("f"));
    }

    @Test
    public void readableKeepsALongIntegral() {
        final Map<String, Serializable> persisted = new LinkedHashMap<>();
        persisted.put("n", AttributeBridge.MAX_SAFE_LONG);
        final Map<String, Object> result = AttributeBridge.readable(persisted);
        assertEquals(Double.valueOf((double) AttributeBridge.MAX_SAFE_LONG), result.get("n"));
    }

    @Test
    public void readableTurnsAStringSetIntoAList() {
        final Map<String, Serializable> persisted = new LinkedHashMap<>();
        persisted.put("tags", new LinkedHashSet<>(Arrays.asList("a", "b")));
        final Map<String, Object> result = AttributeBridge.readable(persisted);
        assertEquals(Arrays.asList("a", "b"), result.get("tags"));
    }

    @Test
    public void readableDropsUnknownTypes() {
        final Map<String, Serializable> persisted = new LinkedHashMap<>();
        persisted.put("kept", "value");
        persisted.put("dropped", new java.util.Date(0));
        final Map<String, Object> result = AttributeBridge.readable(persisted);
        assertEquals(Collections.singletonMap("kept", (Object) "value"), result);
    }

    @Test
    public void readableMapsNullToEmpty() {
        assertTrue(AttributeBridge.readable(null).isEmpty());
    }

    @Test
    public void readableKeepsABooleanAsIs() {
        final Map<String, Serializable> persisted = new LinkedHashMap<>();
        persisted.put("flag", Boolean.TRUE);
        final Map<String, Object> result = AttributeBridge.readable(persisted);
        assertEquals(Boolean.TRUE, result.get("flag"));
    }

    // --- readOne -------------------------------------------------------------

    @Test
    public void readOneReadsThePersistedCopyNotTheMemoryCopy() {
        final FakeSdk sdk = new FakeSdk();
        sdk.memory.put("n", 0.1);
        sdk.persisted.put("n", 0.1f);
        assertEquals(Double.valueOf(0.10000000149011612), AttributeBridge.readOne(sdk, "n"));
    }

    // --- identifier ------------------------------------------------------------

    @Test
    public void emptyIdentifierReadsAsAbsent() {
        assertNull(AttributeBridge.identifier(null));
        assertNull(AttributeBridge.identifier(""));
        assertEquals("alice", AttributeBridge.identifier("alice"));
    }
}
