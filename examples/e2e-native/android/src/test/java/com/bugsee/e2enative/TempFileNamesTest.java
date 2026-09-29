package com.bugsee.e2enative;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The native re-check of writeTempFile's name (Task 7.6a). JS validates
 * first (src/index.ts); this is the second fence, so it must refuse the same
 * names on its own. Run from examples/bare/android:
 * ./gradlew :bugsee-e2e-native:testDebugUnitTest
 */
public class TempFileNamesTest {

    private static String repeat(final char c, final int count) {
        final StringBuilder out = new StringBuilder();
        for (int i = 0; i < count; i++) {
            out.append(c);
        }
        return out.toString();
    }

    @Test
    public void acceptsPlainNames() {
        for (final String name : new String[] {
                "a", "A_b-c.9", "smoke-0123abcd.txt", ".hidden", "a..b", repeat('x', 64)}) {
            assertTrue(name, TempFileNames.isPlain(name));
        }
    }

    @Test
    public void refusesNamesThatAreNotPlain() {
        for (final String name : new String[] {
                "", repeat('x', 65), "a/b", "../escape", "/abs", "a\\b", "sp ace",
                "é", "／", "a\u0000b", "tab\t", "new\nline"}) {
            assertFalse(name, TempFileNames.isPlain(name));
        }
    }

    @Test
    public void refusesNamesMadeOnlyOfDots() {
        for (final String name : new String[] {".", "..", "...", repeat('.', 64)}) {
            assertFalse(name, TempFileNames.isPlain(name));
        }
    }

    @Test
    public void refusesNull() {
        assertFalse(TempFileNames.isPlain(null));
    }
}
