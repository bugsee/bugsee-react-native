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
  s.prepare_command = <<-CMD
    set -e
    VERSION="#{native['ios']['sdk']}"
    if [ ! -d "Bugsee.xcframework" ]; then
      curl -sSfL -o /tmp/Bugsee-${VERSION}.zip \
        "https://download.bugsee.com/sdk/ios/spm/Bugsee-${VERSION}.zip"
      unzip -q -o /tmp/Bugsee-${VERSION}.zip -d .
      rm -f /tmp/Bugsee-${VERSION}.zip
    fi
  CMD

  s.requires_arc = true
  s.dependency 'React-Core'

  install_modules_dependencies(s) if defined?(install_modules_dependencies)
end
