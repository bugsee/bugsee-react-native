// Prints the lines of text macOS's Vision framework reads off an image, one
// per line: `swift ocr.swift <image>`. Used by observe.ts (`ocrLines`) where
// iOS has no accessibility dump to read, as a screen's ground truth.
import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write("usage: swift ocr.swift <image>\n".data(using: .utf8)!)
  exit(64)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("ocr.swift: cannot read \(url.path)\n".data(using: .utf8)!)
  exit(65)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
// The text under test is a nonce, not a word: correction would "fix" it.
request.usesLanguageCorrection = false
do {
  try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
} catch {
  FileHandle.standardError.write("ocr.swift: \(error)\n".data(using: .utf8)!)
  exit(70)
}
for observation in request.results ?? [] {
  if let best = observation.topCandidates(1).first {
    print(best.string)
  }
}
