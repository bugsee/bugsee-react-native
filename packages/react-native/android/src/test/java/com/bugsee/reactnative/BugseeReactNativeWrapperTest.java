package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.HashMap;
import java.util.Map;

public class BugseeReactNativeWrapperTest {

    private static BugseeReactNativeWrapper wrapper(final Map<String, String> context) {
        return new BugseeReactNativeWrapper("react_native", "1.2.3", "42", context);
    }

    private static Map<String, String> context() {
        final Map<String, String> context = new HashMap<>();
        context.put("react-native", "0.87.1");
        return context;
    }

    @Test
    public void reportsWhatItWasGiven() {
        final BugseeReactNativeWrapper w = wrapper(context());
        assertEquals("react_native", w.getWrapperType());
        assertEquals("1.2.3", w.getWrapperVersion());
        assertEquals("42", w.getWrapperBuild());
        assertEquals("0.87.1", w.getContext().get("react-native"));
    }

    /** The SDKs accept a null build; nothing should invent one. */
    @Test
    public void allowsNoBuild() {
        assertNull(new BugseeReactNativeWrapper("react_native", "1.2.3", null, context())
                .getWrapperBuild());
    }

    /**
     * The SDK holds this wrapper for the process's lifetime and reads context
     * while composing a report. A caller mutating the map it passed in would
     * change what a later report says.
     */
    @Test
    public void copiesTheContextItWasGiven() {
        final Map<String, String> mutable = context();
        final BugseeReactNativeWrapper w = wrapper(mutable);
        mutable.put("react-native", "0.0.0");
        assertEquals("0.87.1", w.getContext().get("react-native"));
    }

    @Test
    public void refusesToHandOutAMutableContext() {
        boolean threw = false;
        try {
            wrapper(context()).getContext().put("x", "y");
        } catch (final UnsupportedOperationException expected) {
            threw = true;
        }
        assertTrue("context must not be mutable by the SDK or anyone else", threw);
    }

    /**
     * The view hierarchy arrives in a later phase. What matters now is that
     * the callback is ALWAYS invoked: a provider that never answers leaves
     * the SDK waiting mid-capture.
     */
    @Test
    public void answersEveryDataRequestEvenWhenItHasNothing() {
        final String[] result = { "untouched" };
        wrapper(context()).requestData("vh", data -> result[0] = data);
        assertNull(result[0]);
    }

    @Test
    public void answersAnUnknownDataTypeToo() {
        final boolean[] called = { false };
        wrapper(context()).requestData("something-new", data -> called[0] = true);
        assertTrue(called[0]);
    }

    /**
     * The wrapper object is REPLACED mid-session: the init provider registers
     * one before launch, and setWrapperInfo swaps in a fully-populated one as
     * soon as the bridge is up. Secure regions belong to the app, not to
     * whichever wrapper instance is current, so they must survive that swap.
     * If they did not, every app would be recorded unredacted for the window
     * between the swap and the next time it happened to re-publish.
     */
    @Test
    public void securedRegionsSurviveTheWrapperBeingReplaced() {
        SecureRectangleStore.shared().set(0, new int[] { 1, 2, 3, 4 });

        final int[] packed = wrapper(context()).getSecureRectangles(0);

        assertEquals(1, packed[1]);
        assertEquals(1, packed[2]);
        assertEquals(4, packed[5]);
    }

    /** The empty set still has to be a well-formed buffer, not null. */
    @Test
    public void publishesAWellFormedBufferForADisplayWithNothingSecured() {
        final int[] packed = wrapper(context()).getSecureRectangles(7);
        assertEquals(2, packed.length);
        assertEquals(0, packed[1]);
    }
}
