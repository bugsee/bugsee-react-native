package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.contracts.internal.BugseeWrapper;

import org.junit.After;
import org.junit.Test;

import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class WrapperRegistrarTest {

    @After
    public void resetTheSharedHolder() {
        WrapperChannelHolder.shared().clear();
    }

    private static BugseeReactNativeWrapper wrapper() {
        return new BugseeReactNativeWrapper(
                "react_native", "1.2.3", null, Collections.<String, String>emptyMap());
    }

    /**
     * The wrapper-channel spec: a wrapper must not call setWrapper
     * concurrently with itself. The provider registers at process start and
     * setWrapperInfo re-registers from the native-modules thread, so two
     * threads do reach it. The fake records a second thread entering while
     * the first is still inside -- and holds the first inside long enough
     * for an unserialised second call to get there.
     */
    @Test
    public void registrationsNeverOverlap() throws Exception {
        final AtomicBoolean inside = new AtomicBoolean();
        final AtomicBoolean overlapped = new AtomicBoolean();
        final CountDownLatch firstIsInside = new CountDownLatch(1);
        final CountDownLatch secondArrived = new CountDownLatch(1);

        final WrapperRegistrar.Setter setter = wrapper -> {
            if (!inside.compareAndSet(false, true)) {
                overlapped.set(true);
                secondArrived.countDown();
                return;
            }
            try {
                firstIsInside.countDown();
                // Serialised, the second caller cannot arrive; this times out.
                secondArrived.await(300, TimeUnit.MILLISECONDS);
            } catch (final InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                inside.set(false);
            }
        };

        final Thread first = new Thread(() -> WrapperRegistrar.registerWith(setter, wrapper()));
        first.start();
        assertTrue(firstIsInside.await(5, TimeUnit.SECONDS));
        final Thread second = new Thread(() -> WrapperRegistrar.registerWith(setter, wrapper()));
        second.start();
        first.join(5000);
        second.join(5000);

        assertFalse("two registrations ran inside setWrapper at once", overlapped.get());
    }

    /** Registering null retires the SDK's channel; ours must not outlive it. */
    @Test
    public void unregisteringClearsTheChannel() {
        final WrapperChannelHolderTest.RecordingChannel channel =
                new WrapperChannelHolderTest.RecordingChannel();
        WrapperChannelHolder.shared().set(channel);

        WrapperRegistrar.registerWith(wrapper -> { }, null);
        WrapperChannelHolder.shared().log("after unregistering", 3);

        assertTrue(channel.lines.isEmpty());
    }

    /**
     * The SDK delivers the channel from inside setWrapper. Clearing after
     * every registration, rather than only after a null one, would wipe the
     * channel the moment it arrived.
     */
    @Test
    public void registeringAWrapperKeepsTheChannelItWasHanded() {
        final WrapperChannelHolderTest.RecordingChannel channel =
                new WrapperChannelHolderTest.RecordingChannel();
        final WrapperRegistrar.Setter sdk = registered -> {
            if (registered != null) {
                registered.onWrapperChannelAvailable(channel);
            }
        };

        WrapperRegistrar.registerWith(sdk, wrapper());
        WrapperChannelHolder.shared().log("after registering", 3);

        assertEquals(1, channel.lines.size());
    }

    /** Whatever the caller registers is what the SDK is handed. */
    @Test
    public void handsTheSetterTheWrapperItWasGiven() {
        final BugseeWrapper[] seen = new BugseeWrapper[1];
        final BugseeReactNativeWrapper wrapper = wrapper();
        WrapperRegistrar.registerWith(registered -> seen[0] = registered, wrapper);
        assertSame(wrapper, seen[0]);
    }
}
