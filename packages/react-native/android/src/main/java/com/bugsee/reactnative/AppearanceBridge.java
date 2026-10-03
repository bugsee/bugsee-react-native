package com.bugsee.reactnative;

import androidx.annotation.ColorInt;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.appearance.Appearance;

import java.util.Locale;

/**
 * Report colors through {@code Bugsee.getAppearance()}.
 *
 * <p>{@code property} is a {@code ReportAppearance} constant value, such as
 * {@code ReportAppearance.BackgroundColor} ({@code Report::BackgroundColor}).
 * Components are 0–255. Android packs them ARGB, alpha in the high byte.
 */
public final class AppearanceBridge {

    private AppearanceBridge() {
    }

    public static void setColor(
            @NonNull final String property,
            final int r,
            final int g,
            final int b,
            final int a
    ) {
        if (property.length() == 0) {
            throw new IllegalArgumentException("report appearance property is empty");
        }
        checkComponent(r);
        checkComponent(g);
        checkComponent(b);
        checkComponent(a);
        final Appearance appearance = Bugsee.getAppearance();
        appearance.setColor(property, Integer.valueOf(packArgb(r, g, b, a)));
    }

    @Nullable
    @ColorInt
    public static Integer getColor(@NonNull final String property) {
        if (property.length() == 0) {
            return null;
        }
        return Bugsee.getAppearance().getColor(property);
    }

    /**
     * {@code #rrggbbaa}, or {@code ""} when the SDK has no color stored.
     * Alpha is last, matching the CSS hex the JS setter accepts.
     */
    @NonNull
    public static String toHex(@Nullable final Integer color) {
        if (color == null) {
            return "";
        }
        final int packed = color.intValue();
        return String.format(
                Locale.US,
                "#%02x%02x%02x%02x",
                Integer.valueOf((packed >> 16) & 0xff),
                Integer.valueOf((packed >> 8) & 0xff),
                Integer.valueOf(packed & 0xff),
                Integer.valueOf((packed >>> 24) & 0xff)
        );
    }

    static int packArgb(final int r, final int g, final int b, final int a) {
        return (a & 0xff) << 24 | (r & 0xff) << 16 | (g & 0xff) << 8 | (b & 0xff);
    }

    private static void checkComponent(final int value) {
        if (value < 0 || value > 255) {
            throw new IllegalArgumentException("color component out of range: " + value);
        }
    }
}
