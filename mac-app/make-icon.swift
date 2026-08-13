// Renders the JobAgent app icon to a 1024px PNG.
//
// Run through mac-app/build.sh, which downscales the result into an .iconset and packs it
// with iconutil. Kept as source rather than a checked-in binary so the icon can be tweaked
// without a design tool.

import AppKit
import Foundation

let size = 1024.0
let outputPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"

guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(size),
    pixelsHigh: Int(size),
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    FileHandle.standardError.write(Data("could not allocate bitmap\n".utf8))
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

// macOS icons sit inside a rounded square with breathing room around it.
let inset = size * 0.08
let rect = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let squircle = NSBezierPath(roundedRect: rect, xRadius: size * 0.22, yRadius: size * 0.22)

let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.36, green: 0.32, blue: 0.90, alpha: 1),
    NSColor(calibratedRed: 0.16, green: 0.50, blue: 0.94, alpha: 1),
])
gradient?.draw(in: squircle, angle: -90)

// A briefcase reads as "jobs" at Dock size; the bolt alone was too generic.
let config = NSImage.SymbolConfiguration(pointSize: size * 0.42, weight: .semibold)
if let glyph = NSImage(systemSymbolName: "briefcase.fill", accessibilityDescription: nil)?
    .withSymbolConfiguration(config) {
    let tinted = NSImage(size: glyph.size, flipped: false) { bounds in
        NSColor.white.set()
        bounds.fill()
        glyph.draw(in: bounds, from: .zero, operation: .destinationIn, fraction: 1)
        return true
    }
    let target = NSRect(
        x: (size - tinted.size.width) / 2,
        y: (size - tinted.size.height) / 2,
        width: tinted.size.width,
        height: tinted.size.height
    )
    tinted.draw(in: target, from: .zero, operation: .sourceOver, fraction: 1)
}

NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write(Data("could not encode png\n".utf8))
    exit(1)
}
try png.write(to: URL(fileURLWithPath: outputPath))
