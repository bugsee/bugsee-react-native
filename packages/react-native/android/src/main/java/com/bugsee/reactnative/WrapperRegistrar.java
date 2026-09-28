package com.bugsee.reactnative;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.internal.BugseeWrapper;

/**
 * The one place this wrapper calls {@code Bugsee.setWrapper}.
 *
 * <p>The wrapper-channel spec requires a wrapper not to register concurrently
 * with itself, and this one registers from two threads: the init provider at
 * process start, and {@code setWrapperInfo} on the native-modules thread once
 * JS is up. On Android the SDK delivers the channel under its registration
 * lock, so two racing registrations could leave a superseded channel stored.
 * Every registration takes {@link #LOCK} instead; a test fails any
 * {@code setWrapper} call made anywhere else.
 *
 * <p>This cannot deadlock against the SDK's lock: the callback that runs
 * under it, {@code onWrapperChannelAvailable}, only stores the channel and
 * never takes {@link #LOCK}.
 */
final class WrapperRegistrar {

    /** Its own interface: {@code java.util.function} needs API 24, minSdk is 21. */
    interface Setter {
        void set(@Nullable BugseeWrapper wrapper);
    }

    private static final Object LOCK = new Object();
    private static final Setter SDK = Bugsee::setWrapper;

    private WrapperRegistrar() {
    }

    static void register(@Nullable final BugseeWrapper wrapper) {
        registerWith(SDK, wrapper);
    }

    /**
     * A non-null wrapper is handed its channel from inside {@code setter}, so
     * the holder is cleared only after a null registration -- clearing after
     * every one would wipe the channel the moment it arrived.
     */
    static void registerWith(@NonNull final Setter setter, @Nullable final BugseeWrapper wrapper) {
        synchronized (LOCK) {
            setter.set(wrapper);
            if (wrapper == null) {
                WrapperChannelHolder.shared().clear();
            }
        }
    }
}
