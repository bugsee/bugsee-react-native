package com.bugsee.e2enative;

import androidx.annotation.Nullable;

import com.facebook.react.BaseReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfo;
import com.facebook.react.module.model.ReactModuleInfoProvider;

import java.util.HashMap;
import java.util.Map;

/** What examples/bare's autolinking registers (react-native.config.js). */
public class BugseeE2EPackage extends BaseReactPackage {

    @Nullable
    @Override
    public NativeModule getModule(final String name, final ReactApplicationContext context) {
        return BugseeE2EModule.NAME.equals(name) ? new BugseeE2EModule(context) : null;
    }

    @Override
    public ReactModuleInfoProvider getReactModuleInfoProvider() {
        return () -> {
            final Map<String, ReactModuleInfo> modules = new HashMap<>();
            modules.put(
                    BugseeE2EModule.NAME,
                    new ReactModuleInfo(
                            BugseeE2EModule.NAME,
                            BugseeE2EModule.NAME,
                            /* canOverrideExistingModule */ false,
                            /* needsEagerInit */ false,
                            /* isCxxModule */ false,
                            /* isTurboModule */ true));
            return modules;
        };
    }
}
