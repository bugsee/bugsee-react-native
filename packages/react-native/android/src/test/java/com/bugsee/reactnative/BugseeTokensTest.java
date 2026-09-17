package com.bugsee.reactnative;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BugseeTokensTest {

    @Test
    public void rejectsBlankTokens() {
        assertFalse(BugseeTokens.isUsable(null));
        assertFalse(BugseeTokens.isUsable(""));
        assertFalse(BugseeTokens.isUsable("   "));
        assertFalse(BugseeTokens.isUsable("\t\n"));
    }

    @Test
    public void acceptsARealToken() {
        assertTrue(BugseeTokens.isUsable("00000000-0000-4000-8000-000000000000"));
    }

    /** Surrounding whitespace is a copy-paste artefact, not a different token. */
    @Test
    public void acceptsATokenPaddedWithWhitespace() {
        assertTrue(BugseeTokens.isUsable("  tok  "));
    }
}
