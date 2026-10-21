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

    @Test
    public void holdsTheFiltersTheMetaDataNames() {
        final List<String> held = new ArrayList<>();

        ReactNativeWrapperInitProvider.holdFiltersEarly("log,breadcrumb", new StartupHold.Targets() {
            @Override
            public void holdNetwork() {
                held.add("network");
            }

            @Override
            public void holdLog() {
                held.add("log");
            }

            @Override
            public void holdBreadcrumb() {
                held.add("breadcrumb");
            }
        });

        assertEquals(java.util.Arrays.asList("log", "breadcrumb"), held);
    }

    @Test
    public void anApplicationWithoutMetaDataHoldsNothing() {
        final android.content.pm.ApplicationInfo info = new android.content.pm.ApplicationInfo();
        info.metaData = null;
        org.junit.Assert.assertNull(ReactNativeWrapperInitProvider.holdFiltersValueOf(info));
    }

    @Test
    public void aContextWhosePackageManagerThrowsReadsAsNoMetaData() {
        // A ContextWrapper over nothing: getPackageManager() dereferences the null base.
        final android.content.Context broken = new android.content.ContextWrapper(null);
        org.junit.Assert.assertNull(ReactNativeWrapperInitProvider.holdFiltersMetaData(broken));
    }

    @Test
    public void readsNoMetaDataFromAMissingContext() {
        org.junit.Assert.assertNull(ReactNativeWrapperInitProvider.holdFiltersMetaData(null));
    }

    @Test
    public void anErrorFromEveryHoldDoesNotEscape() {
        ReactNativeWrapperInitProvider.holdFiltersEarly("all", new StartupHold.Targets() {
            @Override
            public void holdNetwork() {
                throw new NoClassDefFoundError("com/bugsee/library/Bugsee");
            }

            @Override
            public void holdLog() {
                throw new IllegalStateException();
            }

            @Override
            public void holdBreadcrumb() {
                throw new OutOfMemoryError();
            }
        });
    }
}
