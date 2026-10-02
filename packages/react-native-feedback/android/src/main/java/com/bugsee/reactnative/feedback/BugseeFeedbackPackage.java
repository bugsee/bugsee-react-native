package com.bugsee.reactnative.feedback;

import androidx.annotation.Nullable;

import com.facebook.react.BaseReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfo;
import com.facebook.react.module.model.ReactModuleInfoProvider;

import java.util.HashMap;
import java.util.Map;

/**
 * What autolinking finds. The app never names it.
 */
public class BugseeFeedbackPackage extends BaseReactPackage {

    @Nullable
    @Override
    public NativeModule getModule(final String name, final ReactApplicationContext context) {
        return BugseeFeedbackModule.NAME.equals(name) ? new BugseeFeedbackModule(context) : null;
    }

    @Override
    public ReactModuleInfoProvider getReactModuleInfoProvider() {
        return () -> {
            final Map<String, ReactModuleInfo> modules = new HashMap<>();
            modules.put(
                    BugseeFeedbackModule.NAME,
                    new ReactModuleInfo(
                            BugseeFeedbackModule.NAME,
                            BugseeFeedbackModule.NAME,
                            /* canOverrideExistingModule */ false,
                            /* needsEagerInit */ false,
                            /* isCxxModule */ false,
                            /* isTurboModule */ true));
            return modules;
        };
    }
}
