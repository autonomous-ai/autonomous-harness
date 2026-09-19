// Appended to the production AppKit source by check_swarm_titlebar.sh --window-zoom.
// No Flutter engine, saved app state or visible windows are needed.
private struct WindowZoomCheckFailure: Error {
  let message: String
}

private var windowZoomCheckCount = 0
private func checkWindowZoom(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  guard condition() else { throw WindowZoomCheckFailure(message: message) }
  windowZoomCheckCount += 1
}

private final class WindowZoomMouseUpProbe: NSResponder {
  var mouseUps = 0
  override func mouseUp(with event: NSEvent) { mouseUps += 1 }
}

private final class WindowZoomCheckWindow: NSWindow {
  var zoomCount = 0
  var dragCount = 0
  override func zoom(_ sender: Any?) {
    zoomCount += 1
    super.zoom(sender)
  }
  // A synthetic mouse-down has no real tracking loop to hand off to.
  override func performDrag(with event: NSEvent) { dragCount += 1 }
}

private final class WindowZoomCheckMessenger: NSObject, FlutterBinaryMessenger {
  func send(onChannel channel: String, message: Data?) {}
  func send(onChannel channel: String, message: Data?, binaryReply callback: FlutterBinaryReply?) {
    callback?(FlutterStandardMethodCodec.sharedInstance().encodeSuccessEnvelope(nil))
  }
  func setMessageHandlerOnChannel(_ channel: String,
    binaryMessageHandler handler: FlutterBinaryMessageHandler?) -> FlutterBinaryMessengerConnection { 1 }
  func cleanUpConnection(_ connection: FlutterBinaryMessengerConnection) {}
}

private func windowZoomMouseEvent(_ type: NSEvent.EventType, count: Int,
  point: NSPoint, time: TimeInterval, window: NSWindow? = nil) -> NSEvent {
  NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: time,
    windowNumber: window?.windowNumber ?? 0, context: nil,
    eventNumber: count, clickCount: count, pressure: 1)!
}

private extension SwarmTabStrip {
  func checkReleaseIsolation() throws {
    let parent = nextResponder
    let probe = WindowZoomMouseUpProbe()
    nextResponder = probe
    defer { nextResponder = parent }
    // Exercise both halves of each click. Checking only the double-click
    // predicate misses mouse-up bubbling into AppKit's own titlebar zoom.
    for count in 1...3 {
      for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
        let event = windowZoomMouseEvent(type, count: count, point: NSPoint(x: 40, y: 20),
          time: Double(count) * NSEvent.doubleClickInterval / 4)
        if type == .leftMouseDown { mouseDown(with: event) }
        else { mouseUp(with: event) }
      }
      try checkWindowZoom(probe.mouseUps == 0,
        "Background click \(count) cannot also reach AppKit's titlebar zoom handler")
    }
    try checkWindowZoom(!mouseDownCanMoveWindow,
      "Explicit background drag and zoom handling opts out of automatic window movement")
  }

  func checkTabDoubleClick(_ window: WindowZoomCheckWindow) throws {
    update(["enabled": true, "activeId": "test", "tabs": [["id": "test", "name": "Test tab"]]])
    var actions: [String] = []
    emit = { method, _ in actions.append(method) }
    let tab = tabs[0]
    let point = tab.convert(NSPoint(x: tab.bounds.midX, y: tab.bounds.midY), to: nil)
    let zoomCount = window.zoomCount
    for count in 1...2 {
      tab.mouseDown(with: windowZoomMouseEvent(.leftMouseDown, count: count, point: point,
        time: Double(count) * NSEvent.doubleClickInterval / 4, window: window))
      tab.mouseUp(with: windowZoomMouseEvent(.leftMouseUp, count: count, point: point,
        time: Double(count) * NSEvent.doubleClickInterval / 4, window: window))
    }
    try checkWindowZoom(actions == ["select", "rename"], "A tab double-click still selects and renames")
    try checkWindowZoom(window.zoomCount == zoomCount, "A tab double-click does not resize the window")
  }

  func checkWindowGestures(_ window: WindowZoomCheckWindow) throws {
    let restoredFrame = window.frame
    for sequence in 0..<2 {
      let point = convert(NSPoint(x: createButton.frame.minX - 12, y: bounds.midY), to: nil)
      for count in 1...2 {
        let time = Double(sequence + 1) + Double(count) * NSEvent.doubleClickInterval / 4
        mouseDown(with: windowZoomMouseEvent(.leftMouseDown, count: count, point: point,
          time: time, window: window))
        mouseUp(with: windowZoomMouseEvent(.leftMouseUp, count: count, point: point,
          time: time, window: window))
      }
      // Include delayed titlebar layout/resize callbacks, not just mouseDown.
      RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.35))
      try checkWindowZoom(window.zoomCount == sequence + 1,
        "Each complete background double-click zooms the native window exactly once")
      try checkWindowZoom(window.dragCount == sequence + 1,
        "The first background click still hands window dragging to AppKit")
      try checkWindowZoom(window.isZoomed == (sequence == 0),
        "The native window stays maximized until the next deliberate double-click")
    }
    try checkWindowZoom(window.frame == restoredFrame,
      "The next background double-click restores the original window frame")
    try checkTabDoubleClick(window)
    try checkWindowZoom(!window.isVisible, "Window gesture checks never display the test window")
  }
}

private extension SwarmTitlebar {
  func checkWindowGestures(_ window: WindowZoomCheckWindow) throws {
    configure()
    window.contentView?.superview?.layoutSubtreeIfNeeded()
    resize()
    window.contentView?.superview?.layoutSubtreeIfNeeded()
    strip.layoutSubtreeIfNeeded()
    try strip.checkWindowGestures(window)
  }
}

let windowZoomCheckApp = NSApplication.shared
windowZoomCheckApp.setActivationPolicy(.prohibited)
do {
  try checkWindowZoom(NSEvent.doubleClickInterval > 0,
    "AppKit must be able to read the system double-click interval")
  let strip = SwarmTabStrip(frame: NSRect(x: 0, y: 0, width: 900, height: 52))
  try strip.checkReleaseIsolation()
  let window = WindowZoomCheckWindow(contentRect: NSRect(x: 120, y: 120, width: 960, height: 640),
    styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
  window.isReleasedWhenClosed = false
  defer { window.close() }
  let titlebar = SwarmTitlebar(window: window, messenger: WindowZoomCheckMessenger())
  try titlebar.checkWindowGestures(window)
  print("AppKit window zoom: \(windowZoomCheckCount) checks passed; no windows displayed.")
} catch {
  let message = (error as? WindowZoomCheckFailure)?.message ?? String(describing: error)
  FileHandle.standardError.write(Data("AppKit window zoom failed: \(message)\n".utf8))
  exit(1)
}
