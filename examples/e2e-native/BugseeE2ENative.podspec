require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# The example-only `bugsee-e2e-native` module (Task 7.6a). Autolinked into
# examples/bare only; never published, never a dependency of
# @bugsee/react-native.
Pod::Spec.new do |s|
  s.name         = 'BugseeE2ENative'
  s.version      = package['version']
  s.summary      = 'Example-only native test helpers for the Bugsee React Native device tests'
  s.homepage     = 'https://www.bugsee.com'
  s.license      = { :type => 'Commercial', :text => 'Example-only test code; not distributed.' }
  s.author       = 'Bugsee'
  s.platforms    = {
    :ios => defined?(min_ios_version_supported) ? min_ios_version_supported : '15.1'
  }
  s.source       = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm}'
  # SPM's forced prefix header (ios/Package.swift); CocoaPods has its own .pch.
  s.exclude_files = 'ios/Package.swift', 'ios/react-native-spm-prefix.h'
  s.requires_arc = true

  install_modules_dependencies(s)
end
