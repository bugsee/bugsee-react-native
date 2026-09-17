package com.bugsee.reactnative;

import androidx.annotation.Nullable;

/**
 * App-token validation, shared by every bridge entry point that takes one.
 *
 * <p>Deliberately permissive about shape: the token's format is the server's
 * business, and a wrapper that rejected an otherwise-valid token because the
 * format changed would be worse than one that forwarded it. Only genuinely
 * unusable input — absent or whitespace — is refused, and refused early, so
 * the failure names the real problem instead of surfacing as a confusing
 * launch failure later.
 */
public final class BugseeTokens {

    private BugseeTokens() {}

    public static boolean isUsable(@Nullable final String token) {
        return token != null && !token.trim().isEmpty();
    }
}
