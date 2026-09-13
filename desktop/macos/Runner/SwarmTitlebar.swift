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
    accessory.layoutAttribute = .right
    accessory.fullScreenMinHeight = 40
    accessory.view = strip
    window.addTitlebarAccessoryViewController(accessory)
    resize()
    installSwarmMenu()
  }

  private func resize() {
    guard let window else { return }
    strip.setFrameSize(NSSize(width: max(200, window.frame.width - 92), height: 40))
    strip.needsLayout = true
  }

  private func installSwarmMenu() {
    guard let main = NSApp.mainMenu, main.item(withTitle: "Swarm") == nil else { return }
    let menu = NSMenu(title: "Swarm")
    func add(_ title: String, _ key: String, _ action: String, _ modifiers: NSEvent.ModifierFlags = [.command]) {
      let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
      item.keyEquivalentModifierMask = modifiers
      item.target = self
      item.representedObject = action
      menu.addItem(item)
    }
    add("New Swarm", "t", "new")
    add("Close Swarm", "w", "closeActive")
    add("Rename Swarm…", "r", "renameActive", [.command, .shift])
    menu.addItem(.separator())
    add("Next Swarm", "]", "next", [.command, .shift])
    add("Previous Swarm", "[", "previous", [.command, .shift])
    menu.addItem(.separator())
    add("Add Agent…", "f", "addAgent", [.command, .shift])
    add("Close Agent View", "w", "closePane", [.command, .shift])
    add("Settings…", ",", "settings")
    let item = NSMenuItem(title: "Swarm", action: nil, keyEquivalent: "")
    item.submenu = menu
    main.insertItem(item, at: min(2, main.numberOfItems))
  }

  func validateMenuItem(_ menuItem: NSMenuItem) -> Bool { actionsEnabled }

  @objc private func menuAction(_ sender: NSMenuItem) {
    guard actionsEnabled, let action = sender.representedObject as? String else { return }
    channel.invokeMethod(action, arguments: nil)
  }
}

private let swarmPasteboardType = NSPasteboard.PasteboardType("ai.autonomous.harness.v2.swarm")

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
    if let active = tabs.first(where: { $0.swarmId == activeId }) { document.scrollToVisible(active.frame) }
  }

  override func layout() {
    super.layout()
    let available = max(120, bounds.width - 106)
    let width = min(204, max(124, available / CGFloat(max(1, tabs.count))))
    let occupied = min(available, CGFloat(tabs.count) * width)
    scroll.frame = NSRect(x: 0, y: 0, width: occupied, height: 40)
    document.frame = NSRect(x: 0, y: 0, width: max(occupied, CGFloat(tabs.count) * width), height: 40)
    for (index, tab) in tabs.enumerated() {
      tab.frame = NSRect(x: CGFloat(index) * width, y: 0, width: width - 2, height: 36)
    }
    newButton.frame = NSRect(x: occupied + 3, y: 4, width: 30, height: 30)
    notifications.frame = NSRect(x: bounds.width - 69, y: 4, width: 30, height: 30)
    settings.frame = NSRect(x: bounds.width - 35, y: 4, width: 30, height: 30)
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

private final class SwarmTabButton: NSView, NSDraggingSource {
  let swarmId: String
  var name = "New swarm"
  var selected = false
  var attention = false
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
    closeButton.imageScaling = .scaleProportionallyDown
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
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layout() {
    super.layout()
    selectButton.frame = NSRect(x: 0, y: 0, width: max(0, bounds.width - 29), height: bounds.height)
    closeButton.frame = NSRect(x: bounds.width - 27, y: 9, width: 18, height: 18)
  }
  override func draw(_ dirtyRect: NSRect) {
    if selected {
      NSColor(srgbRed: 0.275, green: 0.216, blue: 0.275, alpha: 1).setFill()
      NSBezierPath(roundedRect: bounds, xRadius: 9, yRadius: 9).fill()
    }
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    (name as NSString).draw(in: NSRect(x: 13, y: 9, width: bounds.width - 45, height: 19),
      withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: selected ? .medium : .regular),
        .foregroundColor: selected ? NSColor.white : NSColor(white: 0.72, alpha: 1), .paragraphStyle: paragraph])
    if attention {
      NSColor.systemOrange.setFill()
      NSBezierPath(ovalIn: NSRect(x: 4, y: 16, width: 4, height: 4)).fill()
    }
    setAccessibilityLabel(name)
    selectButton.setAccessibilityLabel("Select \(name)")
    selectButton.setAccessibilityValue(selected ? "Selected" : "")
    toolTip = "\(name) — double-click to rename"
    closeButton.setAccessibilityLabel("Close \(name)")
  }
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
