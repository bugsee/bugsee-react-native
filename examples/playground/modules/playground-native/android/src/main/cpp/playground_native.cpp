#include <jni.h>
#include <cstdlib>
extern "C" JNIEXPORT void JNICALL
Java_expo_modules_playgroundnative_PlaygroundNativeModule_nativeCrash(JNIEnv*, jobject, jint kind) {
  if (kind == 1) abort();
  volatile int* p = nullptr;
  *p = 42;
}
