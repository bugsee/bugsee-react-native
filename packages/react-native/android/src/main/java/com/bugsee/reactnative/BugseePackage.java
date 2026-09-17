package com.bugsee.reactnative;

import androidx.annotation.Nullable;

import com.facebook.react.BaseReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfo;
import com.facebook.react.module.model.ReactModuleInfoProvider;

import java.util.HashMap;
import java.util.Map;

/**
 * What autolinking finds. The app never names it; `autolinkLibrariesFromCommand`
 * discovers this class and writes it into the generated PackageList.
 */
public class BugseePackage extends BaseReactPackage {

    @Nullable
    @Override
    public NativeModule getModule(final String name, final ReactApplicationContext context) {
        return BugseeModule.NAME.equals(name) ? new BugseeModule(context) : null;
    }

    @Override
    public ReactModuleInfoProvider getReactModuleInfoProvider() {
        return () -> {
            final Map<String, ReactModuleInfo> modules = new HashMap<>();
            modules.put(
                    BugseeModule.NAME,
                    new ReactModuleInfo(
                            BugseeModule.NAME,
                            BugseeModule.NAME,
                            /* canOverrideExistingModule */ false,
                            /* needsEagerInit */ false,
                            /* isCxxModule */ false,
                            /* isTurboModule */ true));
            return modules;
        };
    }
}
