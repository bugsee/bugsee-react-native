package com.bugsee.e2enative;

import java.util.regex.Pattern;

/**
 * The native re-check of writeTempFile's name: the JS rule (src/index.ts)
 * again, as plain Java so a JVM test covers it (TempFileNamesTest). A plain
 * name has no separator, so it cannot leave the cache directory.
 */
final class TempFileNames {

    /** ASCII only: Java's \w without UNICODE_CHARACTER_CLASS, as JS's \w. */
    private static final Pattern PLAIN = Pattern.compile("^[\\w.-]{1,64}$");

    private static final Pattern ONLY_DOTS = Pattern.compile("^\\.+$");

    private TempFileNames() {}

    /** 1-64 of [A-Za-z0-9_.-], and not only dots (`.`, `..` name directories). */
    static boolean isPlain(final String name) {
        return name != null
                && PLAIN.matcher(name).matches()
                && !ONLY_DOTS.matcher(name).matches();
    }
}
