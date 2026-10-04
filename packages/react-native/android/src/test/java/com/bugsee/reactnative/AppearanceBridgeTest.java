package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.Bugsee;
import com.bugsee.library.contracts.appearance.ReportAppearance;

import org.junit.Test;

public class AppearanceBridgeTest {

    @Test
    public void setColorStoresTheReportAppearanceConstant() {
        final int packed = AppearanceBridge.packArgb(0x11, 0x22, 0x33, 0x44);
        AppearanceBridge.setColor(ReportAppearance.BackgroundColor, 0x11, 0x22, 0x33, 0x44);
        assertEquals(
                Integer.valueOf(packed),
                Bugsee.getAppearance().getColor(ReportAppearance.BackgroundColor));
        assertEquals("Report::BackgroundColor", ReportAppearance.BackgroundColor);
        assertEquals("#11223344", AppearanceBridge.getColor(ReportAppearance.BackgroundColor) == null
                ? ""
                : AppearanceBridge.toHex(AppearanceBridge.getColor(ReportAppearance.BackgroundColor)));
    }

    @Test
    public void eachReportColorConstantRoundTrips() {
        final String[] keys = new String[] {
                ReportAppearance.ActionBarColor,
                ReportAppearance.ActionBarTextColor,
                ReportAppearance.ActionBarButtonBackgroundClickedColor,
                ReportAppearance.BackgroundColor,
                ReportAppearance.EditTextBackgroundColor,
                ReportAppearance.HintColor,
                ReportAppearance.SeverityLabelActiveColor,
                ReportAppearance.TextColor,
                ReportAppearance.VersionColor,
        };
        int n = 1;
        for (final String key : keys) {
            AppearanceBridge.setColor(key, n, n + 1, n + 2, 255);
            assertEquals(
                    Integer.valueOf(AppearanceBridge.packArgb(n, n + 1, n + 2, 255)),
                    AppearanceBridge.getColor(key));
            assertTrue(key.startsWith("Report::"));
            n += 3;
        }
    }

    @Test
    public void packArgbUsesAndroidChannelOrder() {
        assertEquals(0xFF000000, AppearanceBridge.packArgb(0, 0, 0, 255));
        assertEquals(0xFFFF0000, AppearanceBridge.packArgb(255, 0, 0, 255));
        assertEquals(0x44223311, AppearanceBridge.packArgb(0x22, 0x33, 0x11, 0x44));
    }

    @Test
    public void toHexPutsAlphaLast() {
        assertEquals("#11223344", AppearanceBridge.toHex(Integer.valueOf(0x44112233)));
        assertEquals("", AppearanceBridge.toHex(null));
    }

    @Test
    public void anOutOfRangeComponentDoesNotReplaceTheStoredColor() {
        AppearanceBridge.setColor(ReportAppearance.TextColor, 1, 2, 3, 4);
        final Integer before = Bugsee.getAppearance().getColor(ReportAppearance.TextColor);
        try {
            AppearanceBridge.setColor(ReportAppearance.TextColor, 256, 0, 0, 255);
            throw new AssertionError("expected IllegalArgumentException");
        } catch (final IllegalArgumentException expected) {
            // The range, never the component that was out of it.
            assertEquals("color component out of range 0..255", expected.getMessage());
        }
        assertEquals(before, Bugsee.getAppearance().getColor(ReportAppearance.TextColor));
    }

    @Test
    public void anEmptyPropertyIsRejected() {
        try {
            AppearanceBridge.setColor("", 0, 0, 0, 255);
            throw new AssertionError("expected IllegalArgumentException");
        } catch (final IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("empty"));
        }
        assertNull(AppearanceBridge.getColor(""));
    }
}
