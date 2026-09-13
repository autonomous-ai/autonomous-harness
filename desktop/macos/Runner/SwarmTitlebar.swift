import Cocoa
import FlutterMacOS

/// Real AppKit controls in the title bar, beside the system traffic lights.
/// https://developer.apple.com/documentation/appkit/nstitlebaraccessoryviewcontroller/layoutattribute
final class SwarmTitlebar: NSObject, NSMenuItemValidation {
  private weak var window: NSWindow?
  private let channel: FlutterMethodChannel
  private let accessory = NSTitlebarAccessoryViewController()
  private let strip = SwarmTabStrip(frame: NSRect(x: 0, y: 0, width: 900, height: 40))
  private var observers: [NSObjectProtocol] = []
  private var configured = false
  private var actionsEnabled = false
  private var canReopen = false

  init(window: NSWindow, messenger: FlutterBinaryMessenger) {
    self.window = window
    channel = FlutterMethodChannel(name: "harness/swarm_tabs", binaryMessenger: messenger)
    super.init()
    strip.emit = { [weak self] method, args in self?.channel.invokeMethod(method, arguments: args) }
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { result(nil); return }
      switch call.method {
      case "configure":
        self.configure()
        result(true)
      case "update":
        let state = call.arguments as? [String: Any] ?? [:]
        self.actionsEnabled = state["enabled"] as? Bool == true
        self.canReopen = state["canReopen"] as? Bool == true
        self.strip.update(state)
        result(nil)
      default: result(FlutterMethodNotImplemented)
      }
    }
    for name in [NSWindow.didResizeNotification, NSWindow.didEnterFullScreenNotification,
                 NSWindow.didExitFullScreenNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) {
        [weak self] _ in self?.resize()
      })
    }
  }

  deinit { observers.forEach(NotificationCenter.default.removeObserver) }

  private func configure() {
    guard let window, !configured else { return }
    configured = true
    NSWindow.allowsAutomaticWindowTabbing = false
    window.tabbingMode = .disallowed
    window.title = "Harness V2"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.styleMask.remove(.fullSizeContentView)
    window.backgroundColor = NSColor(srgbRed: 0.20, green: 0.16, blue: 0.21, alpha: 1)
    // AppKit fixes a right accessory's height to the title bar. A taller view
    // alone is clipped. A compact unified toolbar gives the native traffic
    // lights and the tab strip one 40-point row, without a second toolbar row.
    let toolbar = NSToolbar(identifier: "harness.swarm.titlebar")
    toolbar.displayMode = .iconOnly
    toolbar.allowsUserCustomization = false
    window.toolbar = toolbar
    window.toolbarStyle = .unifiedCompact
    window.titlebarSeparatorStyle = .none
    accessory.layoutAttribute = .right
    accessory.view = strip
    window.addTitlebarAccessoryViewController(accessory)
    resize()
    installSwarmMenu()
  }

  private func resize() {
    guard let window else { return }
    // AppKit owns height; only width is configurable for a right accessory.
    strip.setFrameSize(NSSize(width: max(200, window.frame.width - 88), height: strip.frame.height))
    strip.needsLayout = true
  }

  private func installSwarmMenu() {
    guard let main = NSApp.mainMenu, main.item(withTitle: "Swarm") == nil else { return }
    // The stock Flutter nib includes a disabled Preferences placeholder. Make
    // the app-menu command work, and give ⌘, a single native owner.
    var settingsInAppMenu = false
    if let appMenu = main.item(at: 0)?.submenu,
       let settings = appMenu.items.first(where: { $0.keyEquivalent == "," && $0.action == nil }) {
      settings.title = "Settings…"
      settings.target = self
      settings.action = #selector(menuAction(_:))
      settings.representedObject = "settings"
      settings.keyEquivalentModifierMask = [.command]
      settingsInAppMenu = true
    }
    let menu = NSMenu(title: "Swarm")
    func add(_ title: String, _ key: String, _ action: String, _ modifiers: NSEvent.ModifierFlags = [.command]) {
      let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
      item.keyEquivalentModifierMask = modifiers
      item.target = self
      item.representedObject = action
      menu.addItem(item)
    }
    add("New Swarm", "t", "new")
    add("Reopen Closed Swarm", "t", "reopen", [.command, .shift])
    add("Close Swarm", "w", "closeActive")
    add("Rename Swarm…", "r", "renameActive", [.command, .shift])
    menu.addItem(.separator())
    add("Next Swarm", "]", "next", [.command, .shift])
    add("Previous Swarm", "[", "previous", [.command, .shift])
    menu.addItem(.separator())
    add("Add Agent…", "f", "addAgent", [.command, .shift])
    add("Close Agent View", "w", "closePane", [.command, .shift])
    if !settingsInAppMenu { add("Settings…", ",", "settings") }
    let item = NSMenuItem(title: "Swarm", action: nil, keyEquivalent: "")
    item.submenu = menu
    main.insertItem(item, at: min(2, main.numberOfItems))
  }

  func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
    actionsEnabled && (menuItem.representedObject as? String != "reopen" || canReopen)
  }

  @objc private func menuAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let action = sender.representedObject as? String else { return }
    channel.invokeMethod(action, arguments: nil)
  }
}

private let swarmPasteboardType = NSPasteboard.PasteboardType("ai.autonomous.harness.v2.swarm")
// Matches AppPalette.swarmField exactly, joining the tab to the terminal canvas.
private let swarmSelectedTabColor = NSColor(srgbRed: 70.0 / 255, green: 55.0 / 255, blue: 70.0 / 255, alpha: 1)

private final class SwarmTabStrip: NSView {
  var emit: ((String, Any?) -> Void)?
  private let scroll = NSScrollView()
  private let document = NSView()
  private let newButton = NSButton()
  private let notifications = NSButton()
  private let settings = NSButton()
  private var tabs: [SwarmTabButton] = []
  private var activeId = ""
  private var actionsEnabled = false
  override var mouseDownCanMoveWindow: Bool { true }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    scroll.drawsBackground = false
    scroll.hasHorizontalScroller = false
    scroll.hasVerticalScroller = false
    scroll.documentView = document
    addSubview(scroll)
    func button(_ button: NSButton, _ symbol: String, _ label: String, _ action: Selector) {
      button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
      button.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
      button.isBordered = false
      button.contentTintColor = NSColor(srgbRed: 0.80, green: 0.75, blue: 0.83, alpha: 1)
      button.target = self
      button.action = action
      button.toolTip = label
      button.setAccessibilityLabel(label)
      addSubview(button)
    }
    button(newButton, "plus", "New swarm (⌘T)", #selector(newSwarm))
    button(notifications, "bell", "Notifications", #selector(showNotifications))
    button(settings, "gearshape", "Settings (⌘,)", #selector(showSettings))
    registerForDraggedTypes([swarmPasteboardType])
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func update(_ state: [String: Any]) {
    actionsEnabled = state["enabled"] as? Bool == true
    let rows = state["tabs"] as? [[String: Any]] ?? []
    activeId = state["activeId"] as? String ?? ""
    let ids = rows.compactMap { $0["id"] as? String }
    let previousOrder = tabs.map(\.swarmId)
    for tab in tabs where !ids.contains(tab.swarmId) { tab.removeFromSuperview() }
    let previous = Dictionary(uniqueKeysWithValues: tabs.map { ($0.swarmId, $0) })
    tabs = rows.compactMap { row in
      guard let id = row["id"] as? String else { return nil }
      let tab = previous[id] ?? SwarmTabButton(id: id)
      tab.name = row["name"] as? String ?? "New swarm"
      tab.selected = id == activeId
      tab.actionsEnabled = actionsEnabled
      tab.attention = (row["attention"] as? Int ?? 0) > 0
      tab.emit = { [weak self] method, args in self?.emit?(method, args) }
      if tab.superview == nil { document.addSubview(tab) }
      tab.needsDisplay = true
      return tab
    }
    for (index, tab) in tabs.enumerated() {
      tab.showsDivider = !tab.selected && index + 1 < tabs.count && !tabs[index + 1].selected
    }
    // Moving frames alone leaves AppKit's child traversal in insertion order.
    document.setAccessibilityChildren(tabs)
    newButton.isEnabled = actionsEnabled && tabs.count < 24
    notifications.isEnabled = actionsEnabled
    settings.isEnabled = actionsEnabled
    let count = state["attention"] as? Int ?? 0
    notifications.image = NSImage(systemSymbolName: count > 0 ? "bell.badge" : "bell",
      accessibilityDescription: count > 0 ? "\(count) agents need input" : "Notifications")
    notifications.toolTip = count > 0 ? "\(count) agents need input" : "Notifications"
    notifications.setAccessibilityLabel(notifications.toolTip)
    needsLayout = true
    layoutSubtreeIfNeeded()
    if ids != previousOrder {
      NSAccessibility.post(element: document, notification: .layoutChanged)
    }
  }

  override func layout() {
    super.layout()
    let available = max(120, bounds.width - 112)
    let width = min(220, max(132, available / CGFloat(max(1, tabs.count))))
    let occupied = min(available, CGFloat(tabs.count) * width)
    scroll.frame = NSRect(x: 0, y: 0, width: occupied, height: bounds.height)
    document.frame = NSRect(x: 0, y: 0, width: max(occupied, CGFloat(tabs.count) * width), height: bounds.height)
    for (index, tab) in tabs.enumerated() {
      tab.frame = NSRect(x: CGFloat(index) * width, y: 0, width: width, height: bounds.height - 6)
      tab.contentCenterY = bounds.midY
    }
    let buttonY = (bounds.height - 28) / 2
    newButton.frame = NSRect(x: occupied + 4, y: buttonY, width: 28, height: 28)
    notifications.frame = NSRect(x: bounds.width - 68, y: buttonY, width: 28, height: 28)
    settings.frame = NSRect(x: bounds.width - 34, y: buttonY, width: 28, height: 28)
    if let active = tabs.first(where: { $0.swarmId == activeId }) {
      document.scrollToVisible(active.frame)
    }
  }
  override func draw(_ dirtyRect: NSRect) {
    // The selected tab meets this edge; its bottom corners are shoulders,
    // rather than the rounded bottom of a separate pill.
    swarmSelectedTabColor.setFill()
    NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
  }
  override func mouseDown(with event: NSEvent) {
    if event.clickCount == 2 { window?.performZoom(nil) }
    else { window?.performDrag(with: event) }
  }
  @objc private func newSwarm() { emit?("new", nil) }
  @objc private func showNotifications() { emit?("notifications", nil) }
  @objc private func showSettings() { emit?("settings", nil) }
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { actionsEnabled ? .move : [] }
  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { actionsEnabled ? .move : [] }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    guard actionsEnabled, let id = sender.draggingPasteboard.string(forType: swarmPasteboardType),
          tabs.contains(where: { $0.swarmId == id }) else { return false }
    let point = document.convert(sender.draggingLocation, from: nil)
    let index = tabs.firstIndex(where: { point.x < $0.frame.midX }) ?? tabs.count
    let old = tabs.firstIndex(where: { $0.swarmId == id })!
    emit?("reorder", ["id": id, "index": max(0, index > old ? index - 1 : index)])
    return true
  }
}

private final class SwarmTabButton: NSView, NSDraggingSource, NSMenuItemValidation {
  let swarmId: String
  var name = "New swarm" { didSet { updateAccessibility() } }
  var selected = false { didSet { updateAccessibility() } }
  var attention = false
  var showsDivider = false
  var contentCenterY: CGFloat = 20
  var emit: ((String, Any?) -> Void)?
  private let closeButton = NSButton()
  private let selectButton = SwarmSelectButton()
  var actionsEnabled = true {
    didSet {
      closeButton.isEnabled = actionsEnabled
      selectButton.isEnabled = actionsEnabled
    }
  }
  private var downPoint = NSPoint.zero
  private var hovered = false
  private var hoverTracking: NSTrackingArea?
  override var acceptsFirstResponder: Bool { false }
  override var mouseDownCanMoveWindow: Bool { false }

  init(id: String) {
    swarmId = id
    super.init(frame: .zero)
    setAccessibilityElement(true)
    setAccessibilityRole(.group)
    selectButton.owner = self
    selectButton.title = ""
    selectButton.isBordered = false
    selectButton.target = self
    selectButton.action = #selector(selectSwarm)
    addSubview(selectButton)
    closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close swarm")
    closeButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 9, weight: .semibold)
    closeButton.contentTintColor = NSColor(white: 0.78, alpha: 1)
    closeButton.isBordered = false
    closeButton.target = self
    closeButton.action = #selector(closeSwarm)
    closeButton.toolTip = "Close swarm"
    addSubview(closeButton)
    let menu = NSMenu()
    for (title, action) in [("Rename Swarm…", #selector(renameSwarm)), ("Close Swarm", #selector(closeSwarm))] {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
      item.target = self
      menu.addItem(item)
    }
    self.menu = menu
    updateAccessibility()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layout() {
    super.layout()
    selectButton.frame = NSRect(x: 0, y: 0, width: max(0, bounds.width - 36), height: bounds.height)
    closeButton.frame = NSRect(x: bounds.width - 36, y: contentCenterY - 12, width: 24, height: 24)
  }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let hoverTracking { removeTrackingArea(hoverTracking) }
    let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self, userInfo: nil)
    addTrackingArea(area)
    hoverTracking = area
  }
  override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
  override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }
  override func draw(_ dirtyRect: NSRect) {
    if selected {
      let w = bounds.width, h = bounds.height
      let shape = NSBezierPath()
      shape.move(to: NSPoint(x: 0, y: 0))
      shape.curve(to: NSPoint(x: 8, y: 8), controlPoint1: NSPoint(x: 4.4, y: 0), controlPoint2: NSPoint(x: 8, y: 3.6))
      shape.line(to: NSPoint(x: 8, y: h - 10))
      shape.curve(to: NSPoint(x: 18, y: h), controlPoint1: NSPoint(x: 8, y: h - 4.5), controlPoint2: NSPoint(x: 12.5, y: h))
      shape.line(to: NSPoint(x: w - 18, y: h))
      shape.curve(to: NSPoint(x: w - 8, y: h - 10), controlPoint1: NSPoint(x: w - 12.5, y: h), controlPoint2: NSPoint(x: w - 8, y: h - 4.5))
      shape.line(to: NSPoint(x: w - 8, y: 8))
      shape.curve(to: NSPoint(x: w, y: 0), controlPoint1: NSPoint(x: w - 8, y: 3.6), controlPoint2: NSPoint(x: w - 4.4, y: 0))
      shape.close()
      swarmSelectedTabColor.setFill()
      shape.fill()
    } else if hovered && actionsEnabled {
      NSColor(white: 1, alpha: 0.05).setFill()
      let hoverRect = NSRect(x: 8, y: contentCenterY - 14, width: bounds.width - 16, height: 28)
      NSBezierPath(roundedRect: hoverRect, xRadius: 10, yRadius: 10).fill()
    }
    if showsDivider && !hovered {
      NSColor(white: 1, alpha: 0.16).setFill()
      NSBezierPath(roundedRect: NSRect(x: bounds.width - 0.5, y: contentCenterY - 8, width: 1, height: 16),
        xRadius: 0.5, yRadius: 0.5).fill()
    }
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    let label = NSAttributedString(string: name,
      attributes: [.font: NSFont.systemFont(ofSize: 12, weight: selected ? .medium : .regular),
        .foregroundColor: selected ? NSColor.white : NSColor(white: 0.72, alpha: 1), .paragraphStyle: paragraph])
    let labelHeight = label.size().height
    label.draw(in: NSRect(x: 24, y: contentCenterY - labelHeight / 2,
      width: bounds.width - 64, height: labelHeight))
    if attention {
      NSColor.systemOrange.setFill()
      NSBezierPath(ovalIn: NSRect(x: 13, y: contentCenterY - 2, width: 4, height: 4)).fill()
    }
  }
  // Overflowed tabs might not be drawn. Their names and selection still need
  // to be available to VoiceOver and automation before they scroll into view.
  private func updateAccessibility() {
    setAccessibilityLabel(name)
    selectButton.setAccessibilityLabel("Select \(name)")
    selectButton.setAccessibilityValue(selected ? "Selected" : "")
    toolTip = "\(name) — double-click to rename"
    closeButton.setAccessibilityLabel("Close \(name)")
  }
  func validateMenuItem(_ menuItem: NSMenuItem) -> Bool { actionsEnabled }
  override func mouseDown(with event: NSEvent) {
    guard actionsEnabled else { return }
    downPoint = event.locationInWindow
    if event.clickCount == 2 { renameSwarm() }
    else { emit?("select", ["id": swarmId]) }
  }
  override func mouseDragged(with event: NSEvent) {
    guard actionsEnabled else { return }
    if hypot(event.locationInWindow.x - downPoint.x, event.locationInWindow.y - downPoint.y) < 5 { return }
    let item = NSPasteboardItem()
    item.setString(swarmId, forType: swarmPasteboardType)
    let dragging = NSDraggingItem(pasteboardWriter: item)
    let snapshot = NSImage(size: bounds.size)
    snapshot.lockFocus()
    draw(bounds)
    snapshot.unlockFocus()
    dragging.setDraggingFrame(bounds, contents: snapshot)
    beginDraggingSession(with: [dragging], event: event, source: self)
  }
  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .move }
  override func accessibilityChildren() -> [Any]? { [selectButton, closeButton] }
  @objc private func selectSwarm() { if actionsEnabled { emit?("select", ["id": swarmId]) } }
  @objc private func closeSwarm() { if actionsEnabled { emit?("close", ["id": swarmId]) } }
  @objc private func renameSwarm() { if actionsEnabled { emit?("rename", ["id": swarmId]) } }
}

/// Selection and closing are sibling accessibility buttons, so VoiceOver and
/// UI automation can reach the close action without treating the tab as a leaf.
private final class SwarmSelectButton: NSButton {
  weak var owner: SwarmTabButton?
  override func mouseDown(with event: NSEvent) {
    guard isEnabled else { return }
    owner?.mouseDown(with: event)
  }
  override func mouseDragged(with event: NSEvent) {
    guard isEnabled else { return }
    owner?.mouseDragged(with: event)
  }
}
