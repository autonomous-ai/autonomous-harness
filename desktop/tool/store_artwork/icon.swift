// Original vector mark: a terminal prompt, cursor, and a spark of capability.
// swift icon.swift <output.png> [size]
import AppKit

let size = CGFloat(Double(CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "256")!)
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
ctx.scaleBy(x: size / 256, y: size / 256)
NSColor(srgbRed: 0.055, green: 0.15, blue: 0.13, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 10, y: 10, width: 236, height: 236), xRadius: 58, yRadius: 58).fill()
let mint = NSColor(srgbRed: 0.48, green: 1, blue: 0.78, alpha: 1)
mint.setStroke()
let prompt = NSBezierPath()
prompt.move(to: NSPoint(x: 65, y: 166))
prompt.line(to: NSPoint(x: 110, y: 126))
prompt.line(to: NSPoint(x: 65, y: 86))
prompt.lineWidth = 18
prompt.lineCapStyle = .round
prompt.lineJoinStyle = .round
prompt.stroke()
let cursor = NSBezierPath()
cursor.move(to: NSPoint(x: 143, y: 84))
cursor.line(to: NSPoint(x: 190, y: 84))
cursor.lineWidth = 17
cursor.lineCapStyle = .round
cursor.stroke()
let spark = NSBezierPath()
spark.move(to: NSPoint(x: 179, y: 209))
spark.curve(to: NSPoint(x: 215, y: 173), controlPoint1: NSPoint(x: 184, y: 183), controlPoint2: NSPoint(x: 189, y: 178))
spark.curve(to: NSPoint(x: 179, y: 137), controlPoint1: NSPoint(x: 189, y: 168), controlPoint2: NSPoint(x: 184, y: 163))
spark.curve(to: NSPoint(x: 143, y: 173), controlPoint1: NSPoint(x: 174, y: 163), controlPoint2: NSPoint(x: 169, y: 168))
spark.curve(to: NSPoint(x: 179, y: 209), controlPoint1: NSPoint(x: 169, y: 178), controlPoint2: NSPoint(x: 174, y: 183))
spark.close()
mint.setFill()
spark.fill()
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
