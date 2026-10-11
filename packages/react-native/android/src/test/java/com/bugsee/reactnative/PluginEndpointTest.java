package com.bugsee.reactnative;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;

import java.io.Serializable;
import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

public class PluginEndpointTest {

    private static final String KEY = "com.bugsee.option.$$ENDPOINT";
    private static final String DEAD = "https://127.0.0.1:9";

    @Test
    public void usesTheKeysTheSdkAndThePluginUse() {
        assertEquals(KEY, PluginEndpoint.OPTION_KEY);
        assertEquals("com.bugsee.reactnative.endpoint", PluginEndpoint.META_DATA_KEY);
    }

    @Test
    public void addsTheConfiguredEndpointWhenJsGaveNone() {
        final Map<String, Serializable> options = new HashMap<>();
        options.put("com.bugsee.option.config.duration", 5);
        final Map<String, Serializable> result = PluginEndpoint.withDefault(options, " " + DEAD + "\n");
        assertEquals(DEAD, result.get(KEY));
        assertEquals(5, result.get("com.bugsee.option.config.duration"));
        assertEquals(2, result.size());
        // The caller's map is not modified.
        assertEquals(1, options.size());
    }

    @Test
    public void keepsAnEndpointJsPassed() {
        final Map<String, Serializable> options = new HashMap<>();
        options.put(KEY, "https://js.example.com");
        assertSame(options, PluginEndpoint.withDefault(options, DEAD));
        assertEquals("https://js.example.com", options.get(KEY));
    }

    @Test
    public void changesNothingWithoutAConfiguredEndpoint() {
        final Map<String, Serializable> options = new HashMap<>();
        assertSame(options, PluginEndpoint.withDefault(options, null));
        assertSame(options, PluginEndpoint.withDefault(options, ""));
        assertSame(options, PluginEndpoint.withDefault(options, " \t\n"));
        assertEquals(0, options.size());
    }
}
