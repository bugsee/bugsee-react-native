package com.bugsee.reactnative;

import androidx.annotation.NonNull;

/**
 * The backend routes React Native JS exceptions on this class name (worker:
 * {@code 'ReactNativeWebException' in name}). {@code consumer-rules.pro} keeps
 * the name through R8. Never rename or nest it.
 *
 * <p>Extends {@link Throwable} (not {@link Exception}): 6.x wrote
 * {@code exception_type "throwable"} in {@code crash.json}, and the reason is
 * the JSON payload verbatim in {@link #getMessage()}.
 */
final class ReactNativeWebException extends Throwable {

    ReactNativeWebException(@NonNull final String payloadJson) {
        super(payloadJson);
    }
}
