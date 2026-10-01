package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.bugsee.library.contracts.options.IssueSeverity;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Severity crosses as the enum's internal value, never its ordinal.
 * {@code values()[4]} is Blocker; value 4 is Critical.
 */
public class ReportArgsTest {

    @Test
    public void zeroIsTheSdkDefault() {
        assertNull(ReportArgs.severity(0));
    }

    @Test
    public void severityIsByValueNotOrdinal() {
        assertEquals(IssueSeverity.Critical, ReportArgs.severity(4));
        assertEquals(IssueSeverity.VeryLow, ReportArgs.severity(1));
        assertEquals(IssueSeverity.Blocker, IssueSeverity.values()[4]);
        assertEquals(IssueSeverity.Medium, IssueSeverity.values()[1]);
    }

    @Test
    public void outOfRangeIsTheDefault() {
        assertNull(ReportArgs.severity(6));
        assertNull(ReportArgs.severity(-1));
        assertNull(ReportArgs.severity(99));
    }

    @Test
    public void labelsBecomeAnArrayList() {
        final ArrayList<String> labels = ReportArgs.labels(Arrays.asList("a", "b"));
        assertEquals(Arrays.asList("a", "b"), labels);
        assertTrue(labels instanceof ArrayList);
    }

    @Test
    public void nullLabelsStayNull() {
        assertNull(ReportArgs.labels(null));
    }

    @Test
    public void nonStringLabelsAreDropped() {
        final List<Object> mixed = new ArrayList<>();
        mixed.add("keep");
        mixed.add(1);
        mixed.add(null);
        mixed.add("also");
        assertEquals(Arrays.asList("keep", "also"), ReportArgs.labels(mixed));
    }
}
