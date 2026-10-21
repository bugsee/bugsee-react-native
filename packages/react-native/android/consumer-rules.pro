# The Bugsee backend routes React Native exceptions on this class name.
-keepnames class com.bugsee.reactnative.ReactNativeWebException

# The launch-time probe matches the plugin-injected interceptor by class name.
-keepnames class com.bugsee.library.okhttp.BugseeOkHttpInterceptor
