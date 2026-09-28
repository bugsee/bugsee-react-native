require 'digest'
require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
native  = JSON.parse(File.read(File.join(__dir__, '..', '..', 'native-versions.json')))

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
  # Bugsee itself supports 15.0 and below -- down to 13.0 -- but React-Core
  # does not, so an app can never actually sit lower than this.
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
  #
  # BUGSEE_IOS_XCFRAMEWORK_ZIP=<absolute path> takes a locally built zip (laid
  # out like the published one) instead of downloading: for a pinned version
  # that is not published yet. Its stamp carries "+local.<sha256 prefix>", so it
  # can never match a published stamp -- unsetting the variable forces a fresh
  # download, and a local build cannot linger into a later `pod install`.
  # CocoaPods only; SPM resolves bugsee/spm and has no equivalent.
  #
  # CocoaPods reruns prepare_command only when it considers the pod changed,
  # which for this :path pod means the podspec's checksum -- a hash of the
  # evaluated spec, this command's text included. A variable read only by the
  # shell changes nothing there: `pod install` after unsetting it would not
  # rerun the command at all, and the local build would stay. So the
  # override's identity is folded into the text below, and setting, unsetting
  # or rebuilding the zip each changes the checksum (and Podfile.lock).
  local_zip = ENV['BUGSEE_IOS_XCFRAMEWORK_ZIP'].to_s
  local_zip_identity =
    if local_zip.empty? then 'none'
    elsif File.file?(local_zip) then Digest::SHA256.file(local_zip).hexdigest[0, 16]
    else 'not-a-file'
    end
  # The command's own stderr WARNING is swallowed by CocoaPods unless the
  # command fails, so say it where `pod install` actually prints it too.
  unless local_zip.empty?
    notice = "Bugsee.xcframework comes from BUGSEE_IOS_XCFRAMEWORK_ZIP (#{local_zip}), not download.bugsee.com"
    defined?(Pod::UI) ? Pod::UI.warn(notice) : warn("WARNING: #{notice}")
  end
  s.prepare_command = <<-CMD
    set -e
    # BUGSEE_IOS_XCFRAMEWORK_ZIP identity: #{local_zip_identity}
    VERSION="#{native['ios']['sdk']}"
    STAMP=".bugsee-xcframework-version"
    ZIP="${BUGSEE_IOS_XCFRAMEWORK_ZIP:-}"
    if [ -n "${ZIP}" ]; then
      if [ ! -f "${ZIP}" ]; then
        echo "BUGSEE_IOS_XCFRAMEWORK_ZIP is set to '${ZIP}', which is not a file." >&2
        exit 1
      fi
      echo "WARNING: Bugsee.xcframework comes from BUGSEE_IOS_XCFRAMEWORK_ZIP, not download.bugsee.com" >&2
      WANT="${VERSION}+local.$(shasum -a 256 "${ZIP}" | cut -c1-16)"
    else
      WANT="${VERSION}"
    fi
    if [ ! -d "Bugsee.xcframework" ] || [ "$(cat "${STAMP}" 2>/dev/null)" != "${WANT}" ]; then
      rm -rf "Bugsee.xcframework"
      if [ -n "${ZIP}" ]; then
        cp "${ZIP}" /tmp/Bugsee-${VERSION}.zip
      else
        curl -sSfL -o /tmp/Bugsee-${VERSION}.zip \
          "https://download.bugsee.com/sdk/ios/spm/Bugsee-${VERSION}.zip"
      fi
      # Only the framework. The archive also carries the iOS SDK's own
      # README.md and LICENSE at its root, and extracting everything drops
      # them into this package -- where npm publishes README.md and LICENSE
      # whatever `files` says. That is how this package came to ship the SDK's
      # CocoaPods instructions and PLCrashReporter's licence.
      unzip -q -o /tmp/Bugsee-${VERSION}.zip 'Bugsee.xcframework/*' -d .
      rm -f /tmp/Bugsee-${VERSION}.zip
      printf '%s' "${WANT}" > "${STAMP}"
    fi
  CMD

  s.requires_arc = true
  s.dependency 'React-Core'

  install_modules_dependencies(s) if defined?(install_modules_dependencies)
end
