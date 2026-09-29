// A real native crash for the device tests (Task 7.6a/7.6b): the process dies
// on a signal raised in native code, which is what the Bugsee NDK extension
// reports, rather than on a Java exception.
#include <jni.h>

#include <cstdlib>

extern "C" JNIEXPORT void JNICALL
Java_com_bugsee_e2enative_BugseeE2EModule_nativeCrash(JNIEnv *, jclass, jint kind) {
  switch (kind) {
    case 0:
      // SIGSEGV. Volatile, and built at -O0 (CMakeLists.txt), so the store
      // really happens.
      *(volatile int *) nullptr = 0x42;
      break;
    case 1:
      // SIGABRT. abort() does not return; the break is for the next reader.
      abort();
      break;
    default:
      break;
  }
}
