require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
# The one source of every native pin. In this repo it is the root file. In an
# app the package sits in node_modules, where the root file is not above it, so
# prepack ships a copy at the package root (scripts/pack-native-versions.ts);
# that copy is read first.
native_versions_file = [
  File.join(__dir__, 'native-versions.json'),
  File.join(__dir__, '..', '..', 'native-versions.json'),
].find { |path| File.file?(path) }
raise "native-versions.json not found in #{__dir__} or the repo root above it" unless native_versions_file
native  = JSON.parse(File.read(native_versions_file))

Pod::Spec.new do |s|
  s.name         = 'BugseeReactNativeFeedback'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = package['homepage']
  s.license      = { :type => 'Commercial', :text => 'See LICENSE at https://www.bugsee.com/terms' }
  s.author       = 'Bugsee'
  s.platforms    = {
    :ios => defined?(min_ios_version_supported) ? min_ios_version_supported : '15.1'
  }
  s.source       = { :path => '.' }
  s.swift_version = '5.9'

  s.source_files = 'ios/**/*.{h,m,mm}', 'BugseeFeedbackSources/**/*.swift'
  # Not public. The pod defines a module because it contains Swift, and Swift
  # imports that underlying module. These headers include the codegen spec,
  # which cannot be built as part of that module.
  s.private_header_files = 'ios/**/*.h'
  # A static pod's `resources` are copied into the app root. This file is
  # named PrivacyInfo.xcprivacy, the same name as the example app's own
  # manifest, and Xcode refuses the duplicate. A resource bundle keeps the
  # manifest (Xcode still aggregates it) at
  # BugseeReactNativeFeedback.bundle/PrivacyInfo.xcprivacy.
  s.resource_bundles = {
    'BugseeReactNativeFeedback' => ['BugseeFeedbackSources/PrivacyInfo.xcprivacy']
  }

  # bugsee/feedback-spm 7.x publishes Swift source. The core SDK's download
  # host has no feedback archive beside its own framework zip, so there is
  # nothing to vendor as a binary. What the SPM channel publishes is the tag.
  # This fetches that tag in a version-stamped prepare_command, the same
  # shape as the core podspec's fetch, and compiles the sources here.
  #
  # The CocoaPods SPM helper is not used: it attaches a product to the Pods
  # target and does not embed it. There is no CocoaPods pod for the core
  # SDK, so this does not declare one. The Swift sources import Bugsee, which
  # the app already gets from BugseeReactNative.
  #
  # The auto-register shim is not copied. It `@import`s the SPM module name,
  # which this pod does not have; BugseeFeedbackModule calls
  # `[BugseeFeedback register]` instead. Registration is idempotent.
  s.prepare_command = <<-CMD
    set -e
    VERSION="#{native['ios']['sdk']}"
    STAMP=".bugsee-feedback-sources-version"
    if [ ! -d "BugseeFeedbackSources" ] || [ "$(cat "${STAMP}" 2>/dev/null)" != "${VERSION}" ]; then
      # A download directory of this run's own, not a fixed /tmp path that
      # concurrent pod installs share; the sources are staged beside their
      # destination and renamed into place, so a failure leaves nothing.
      WORK="$(mktemp -d "${TMPDIR:-/tmp}/bugsee-feedback.XXXXXX")"
      STAGE="$(mktemp -d "./.bugsee-feedback.XXXXXX")"
      trap 'rm -rf "${WORK}" "${STAGE}"' EXIT
      curl -sSfL -o "${WORK}/feedback-spm.tar.gz" \
        "https://codeload.github.com/bugsee/feedback-spm/tar.gz/refs/tags/${VERSION}"
      tar -xzf "${WORK}/feedback-spm.tar.gz" -C "${WORK}"
      SRC="$(echo "${WORK}"/feedback-spm-*/Sources/BugseeFeedback)"
      mkdir "${STAGE}/BugseeFeedbackSources"
      cp -R "${SRC}/." "${STAGE}/BugseeFeedbackSources/"
      rm -rf "BugseeFeedbackSources"
      mv "${STAGE}/BugseeFeedbackSources" "BugseeFeedbackSources"
      printf '%s' "${VERSION}" > "${STAMP}"
    fi
  CMD

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # This pod compiles the Swift sources itself, so the generated header is
    # the target's own "Product-Swift.h", not the SPM module header.
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) BUGSEE_FEEDBACK_COCOAPODS=1',
    'FRAMEWORK_SEARCH_PATHS' => '$(inherited) "${PODS_ROOT}/BugseeReactNative" "${PODS_XCFRAMEWORKS_BUILD_DIR}/BugseeReactNative"'
  }

  s.dependency 'BugseeReactNative'
  s.dependency 'React-Core'

  install_modules_dependencies(s) if defined?(install_modules_dependencies)
end
