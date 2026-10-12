Pod::Spec.new do |s|
  s.name = 'PlaygroundNative'
  s.version = '1.0.0'
  s.summary = 'Playground native triggers'
  s.author = 'Bugsee'
  s.homepage = 'https://www.bugsee.com'
  s.license = 'MIT'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
