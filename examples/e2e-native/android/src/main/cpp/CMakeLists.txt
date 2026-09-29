# The JNI library behind BugseeE2EModule.nativeCrash (Task 7.6a).
cmake_minimum_required(VERSION 3.13)
project(bugsee_e2e_native CXX)

add_library(bugsee_e2e_native SHARED bugsee_e2e_native.cpp)

# -O0, and last on the command line so it beats a release build's -O2: the
# null store must be emitted as a real store, not folded into a trap or
# dropped as undefined behaviour.
target_compile_options(bugsee_e2e_native PRIVATE -O0)
