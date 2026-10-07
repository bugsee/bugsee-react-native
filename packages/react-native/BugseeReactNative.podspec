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
  s.name         = 'BugseeReactNative'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = package['homepage']
  # No :file — the path would be resolved against this package's directory as
  # the autolinker symlinks it into an app's node_modules, so `../../LICENSE`
  # lands in <app>/node_modules/LICENSE and CocoaPods warns it cannot be read.
  s.license      = { :type => 'Commercial', :text => 'See LICENSE at https://www.bugsee.com/terms' }
  s.author       = 'Bugsee'
  # React Native's floor, read from React Native, so it tracks whichever
  # version the app is on rather than drifting. RN defines this top-level
  # helper in scripts/react_native_pods.rb, which every RN Podfile requires,
  # so it is in scope by the time CocoaPods evaluates this podspec; the
  # literal is the fallback for evaluation outside an app (`pod spec lint`).
  # Bugsee itself floors at 15.0 (since 7.0.0-beta2; the bugsee/spm manifest
  # declares .iOS(.v15)), just below React Native's 15.1, so React Native's is
  # the floor that binds and an app can never sit lower than this.
  s.platforms    = {
    :ios => defined?(min_ios_version_supported) ? min_ios_version_supported : '15.1'
  }
  s.source       = { :path => '.' }

  s.source_files = 'ios/**/*.{h,m,mm}'
  # The SPM package under ios/Support is compiled by SPM on the other delivery
  # path; here its sources are part of this pod, so exclude only its manifest.
  s.exclude_files = 'ios/Support/Package.swift', 'ios/Support/Tests/**/*'

  # Bugsee is NOT a CocoaPods dependency: nothing is published to trunk, and
  # never will be. What ships on the SPM channel is a plain xcframework zip at
  # a stable URL, so this vendors that same artifact directly.
  #
  # Deliberately NOT `spm_dependency`. That helper attaches the package product
  # to the Pods project target, and nothing then embeds the framework into the
  # app: a static pod fails to link it at all, and a dynamic one links it and
  # ships an app that dyld-crashes on launch. Both were reproduced. CocoaPods
  # does embed and sign a vendored framework correctly, which is the whole
  # reason this path exists.
  s.vendored_frameworks = "Bugsee.xcframework"
  # The cache is keyed by VERSION, not by mere presence. Checking only that a
  # directory exists means a version bump never replaces an already-downloaded
  # xcframework: `pod install` succeeds, CI goes green, and the app ships the
  # previous SDK. The stamp file records what was unpacked.
  s.prepare_command = <<-CMD
    set -e
    VERSION="#{native['ios']['sdk']}"
    STAMP=".bugsee-xcframework-version"
    if [ ! -d "Bugsee.xcframework" ] || [ "$(cat "${STAMP}" 2>/dev/null)" != "${VERSION}" ]; then
      # A download directory of this run's own. A fixed /tmp path is shared by
      # every pod install on the machine: two at once overwrote and deleted
      # each other's archive mid-extract ("bad CRC").
      WORK="$(mktemp -d "${TMPDIR:-/tmp}/bugsee-xcframework.XXXXXX")"
      # Unpacked beside its destination, so the final mv is a rename on one
      # filesystem: a failed download or extract leaves nothing half-written.
      STAGE="$(mktemp -d "./.bugsee-xcframework.XXXXXX")"
      trap 'rm -rf "${WORK}" "${STAGE}"' EXIT
      curl -sSfL -o "${WORK}/Bugsee.zip" \
        "https://download.bugsee.com/sdk/ios/spm/Bugsee-${VERSION}.zip"
      # Only the framework. The archive also carries the iOS SDK's own
      # README.md and LICENSE at its root, and extracting everything drops
      # them into this package -- where npm publishes README.md and LICENSE
      # whatever `files` says. That is how this package came to ship the SDK's
      # CocoaPods instructions and PLCrashReporter's licence.
      unzip -q -o "${WORK}/Bugsee.zip" 'Bugsee.xcframework/*' -d "${STAGE}"
      rm -rf "Bugsee.xcframework"
      mv "${STAGE}/Bugsee.xcframework" "Bugsee.xcframework"
      printf '%s' "${VERSION}" > "${STAMP}"
    fi
  CMD

  s.requires_arc = true
  # A Swift pod integrated as a static library can only depend on pods that
  # define a module. BugseeReactNativeFeedback does, and this pod is that
  # dependency. Without this, `pod install` stops before it compiles anything.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
  s.dependency 'React-Core'

  install_modules_dependencies(s) if defined?(install_modules_dependencies)
end
