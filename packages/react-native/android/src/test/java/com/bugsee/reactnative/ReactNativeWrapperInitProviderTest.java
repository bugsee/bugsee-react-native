package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import com.bugsee.library.contracts.internal.BugseeWrapper;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * The init provider runs before {@code Application.onCreate}, in every host
 * app that links this library. Anything it throws kills the process before
 * the app has run a line of its own code, so it must swallow -- and log --
 * everything, errors included (a missing SDK class surfaces as a
 * {@link LinkageError}, not an exception).
 */
public class ReactNativeWrapperInitProviderTest {

    @Test
    public void registersTheIdentityOnlyWrapper() {
        final List<BugseeWrapper> registered = new ArrayList<>();

        ReactNativeWrapperInitProvider.registerEarly(registered::add);

        assertEquals(1, registered.size());
        assertNotNull(registered.get(0));
    }

    @Test
    public void swallowsAnExceptionFromRegistration() {
        ReactNativeWrapperInitProvider.registerEarly(wrapper -> {
            throw new IllegalStateException("registration failed");
        });
    }

    @Test
    public void swallowsAnErrorFromRegistration() {
        ReactNativeWrapperInitProvider.registerEarly(wrapper -> {
            throw new NoClassDefFoundError("com/bugsee/library/Bugsee");
        });
    }
}
