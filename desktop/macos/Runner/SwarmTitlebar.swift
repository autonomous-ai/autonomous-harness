import Cocoa
import FlutterMacOS
import ImageIO

/// Real AppKit controls in the title bar, beside the system traffic lights.
/// https://developer.apple.com/documentation/appkit/nstitlebaraccessoryviewcontroller/layoutattribute
final class SwarmTitlebar: NSObject, NSMenuItemValidation, NSMenuDelegate {
  private weak var window: NSWindow?
  private let channel: FlutterMethodChannel
  private let accessory = NSTitlebarAccessoryViewController()
  private let strip = SwarmTabStrip(frame: NSRect(x: 0, y: 0, width: 900, height: 52))
  private var observers: [NSObjectProtocol] = []
  private var configured = false
  private var actionsEnabled = false
  private var canReopen = false
  private var canFind = false
  private var canClosePane = false
  private var canCreateSwarm = false
  private let historyMenu = NSMenu(title: "History")
  private var canGoBack = false
  private var canGoForward = false
  private var history: [SwarmHistoryEntry] = []
  private var closedHistory: [SwarmHistoryEntry] = []
  private let historyIcons = SwarmHistoryIcons()
  private let modelsMenu = NSMenu(title: "Models")
  private let machinesMenu = NSMenu(title: "Machines")
  private var machines: [SwarmMachineEntry] = []
  private var subscriptions: [SwarmSubscriptionEntry] = []
  private var keymap: HarnessNativeKeymap?
  private var flutterKeyContext = "workspace"
  private var tabActionGeneration = 0

  init(window: NSWindow, messenger: FlutterBinaryMessenger) {
    self.window = window
    channel = FlutterMethodChannel(name: "harness/swarm_tabs", binaryMessenger: messenger)
    super.init()
    strip.emit = { [weak self] method, args in
      guard let self else { return }
      self.sendTabAction(method, arguments: args)
    }
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { result(nil); return }
      switch call.method {
      case "configure":
        let state = call.arguments as? [String: Any] ?? [:]
        self.configure(palette: state["palette"] as? [String: Any])
        result(true)
      case "update":
        let state = call.arguments as? [String: Any] ?? [:]
        self.actionsEnabled = state["enabled"] as? Bool == true
        self.canReopen = state["canReopen"] as? Bool == true
        self.canFind = state["canFind"] as? Bool == true
        self.canClosePane = state["canClosePane"] as? Bool == true
        self.canGoBack = state["canGoBack"] as? Bool == true
        self.canGoForward = state["canGoForward"] as? Bool == true
        self.canCreateSwarm = state["canOpenNewTab"] as? Bool
          ?? ((state["tabs"] as? [Any] ?? []).count < 24)
        self.updateHistory(state["history"] as? [[String: Any]] ?? [], closed: state["closedHistory"] as? [[String: Any]] ?? [])
        self.strip.update(state)
        self.window?.backgroundColor = self.strip.palette.tabBar
        result(nil)
      case "machinesState":
        let state = call.arguments as? [String: Any] ?? [:]
        self.updateMachines(state["machines"] as? [[String: Any]] ?? [])
        result(nil)
      case "modelsState":
        let state = call.arguments as? [String: Any] ?? [:]
        self.updateModels(state["subscriptions"] as? [[String: Any]] ?? [])
        result(nil)
      case "keymapState":
        guard let payload = call.arguments as? [String: Any],
              let map = HarnessNativeKeymap(payload) else {
          result(FlutterError(code: "INVALID_KEYMAP", message: "Invalid keyboard configuration", details: nil))
          return
        }
        self.setKeymap(map)
        result(nil)
      case "keymapContext":
        if let context = (call.arguments as? [String: Any])?["context"] as? String,
           ["workspace", "terminal", "picker"].contains(context) {
          self.flutterKeyContext = context
          self.syncMenuKeys()
        }
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

  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
  }

  private func sendTabAction(_ method: String, arguments: Any?) {
    guard ["select", "close", "new", "rename", "commands", "notifications", "addAgent", "newAgent", "splitRight", "splitDown", "zoomPane", "pinPane", "machineDestination", "machineAgent", "manageMachines"].contains(method) else {
      channel.invokeMethod(method, arguments: arguments)
      return
    }
    tabActionGeneration += 1
    let generation = tabActionGeneration
    // Keyboard/VoiceOver activation can leave a button as responder. Wait for
    // Flutter to apply the action before giving the next key to its content.
    channel.invokeMethod(method, arguments: arguments) { [weak self, weak responder = window?.firstResponder] result in
      guard let self, let window = self.window, generation == self.tabActionGeneration,
            !(result is FlutterError), result as? NSObject !== FlutterMethodNotImplemented,
            window.firstResponder === responder || window.firstResponder === window else { return }
      self.focusContent(in: window)
    }
  }

  private func focusContent(in window: NSWindow) {
    guard let content = window.contentViewController?.view else { return }
    // Keep a text field/Flutter input that already took focus while Dart was
    // handling the action. The controller accepts ordinary keys, but Flutter's
    // view wrapper only forwards Command equivalents for its input view.
    if let current = window.firstResponder as? NSView,
       current.isDescendant(of: content) { return }
    func input(in view: NSView) -> NSView? {
      guard !view.isHidden else { return nil }
      if view.acceptsFirstResponder { return view }
      for child in view.subviews {
        if let target = input(in: child) { return target }
      }
      return nil
    }
    window.makeFirstResponder(input(in: content) ?? window.contentViewController)
  }

  private func setKeymap(_ map: HarnessNativeKeymap) {
    keymap = map
    if let main = NSApp.mainMenu, let window {
      let menu = main as? HarnessKeymapMenu ?? HarnessKeymapMenu.replacing(main)
      if NSApp.mainMenu !== menu { NSApp.mainMenu = menu }
      menu.update(map, window: window)
    }
    syncMenuKeys()
  }

  private func syncMenuKeys() {
    guard let keymap, let main = NSApp.mainMenu else { return }
    keymap.applyMenuKeys(to: main, context: flutterKeyContext)
  }

  private func configure(palette: [String: Any]? = nil) {
    // Appearance is loaded before the workspace exists. Apply it before the
    // explicit show request, without inventing tabs or enabling their actions.
    if let palette {
      strip.updatePalette(palette)
      window?.backgroundColor = strip.palette.tabBar
    }
    guard let window, !configured else { return }
    configured = true
    NSWindow.allowsAutomaticWindowTabbing = false
    window.tabbingMode = .disallowed
    window.title = "Harness"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.styleMask.remove(.fullSizeContentView)
    window.backgroundColor = strip.palette.tabBar
    // AppKit fixes a right accessory's height to the title bar. A taller view
    // alone is clipped. A unified toolbar gives the native traffic lights and
    // the tab strip one spacious row, without a second toolbar row.
    let toolbar = NSToolbar(identifier: "harness.swarm.titlebar")
    toolbar.displayMode = .iconOnly
    toolbar.allowsUserCustomization = false
    window.toolbar = toolbar
    window.toolbarStyle = .unified
    window.titlebarSeparatorStyle = .none
    accessory.layoutAttribute = .right
    accessory.view = strip
    window.addTitlebarAccessoryViewController(accessory)
    resize()
    installWorkspaceMenus()
    if let keymap { setKeymap(keymap) }
    // Toolbar controls must not become the window's initial input owner.
    focusContent(in: window)
  }

  private func resize() {
    guard let window else { return }
    // AppKit owns height; only width is configurable for a right accessory.
    let trafficLightEdge = window.standardWindowButton(.zoomButton).map {
      $0.convert($0.bounds, to: nil).maxX
    } ?? 76
    let leading = max(88, trafficLightEdge + 16)
    strip.setFrameSize(NSSize(width: max(200, window.frame.width - leading), height: strip.frame.height))
    strip.needsLayout = true
  }

  private func installWorkspaceMenus() {
    guard let main = NSApp.mainMenu, main.item(withTitle: "Models") == nil else { return }
    // The stock Flutter nib includes a disabled Preferences placeholder. Make
    // the app-menu command work, and give ⌘, a single native owner.
    if let appMenu = main.item(at: 0)?.submenu {
      let settings = appMenu.items.first(where: { $0.keyEquivalent == "," }) ??
        NSMenuItem(title: "Settings…", action: nil, keyEquivalent: ",")
      settings.title = "Settings…"
      settings.target = self
      settings.action = #selector(menuAction(_:))
      settings.representedObject = "settings"
      settings.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + "settings")
      settings.keyEquivalentModifierMask = [.command]
      if settings.menu == nil { appMenu.insertItem(settings, at: min(2, appMenu.numberOfItems)) }
    }
    func add(_ menu: NSMenu, _ title: String, _ key: String, _ action: String, _ modifiers: NSEvent.ModifierFlags = [.command]) {
      let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
      item.keyEquivalentModifierMask = modifiers
      item.target = self
      item.representedObject = action
      item.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + action)
      let symbols = [
        "new": "plus.square", "newAgent": "plus", "addAgent": "arrow.up.right",
        "renameActive": "pencil", "closeActive": "xmark",
        "splitRight": "rectangle.split.2x1", "splitDown": "rectangle.split.1x2",
        "zoomPane": "viewfinder", "closePane": "xmark",
        "commands": "command", "notifications": "bell",
      ]
      if let symbol = symbols[action] {
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
      }
      menu.addItem(item)
    }
    func install(_ menu: NSMenu, at index: Int) {
      let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
      item.submenu = menu
      main.insertItem(item, at: index)
    }
    if let file = main.item(withTitle: "File") { main.removeItem(file) }
    let file = NSMenu(title: "File")
    add(file, "New Tab", "t", "new")
    add(file, "New Harness…", "n", "newAgent")
    add(file, "Open Harness…", "o", "addAgent")
    add(file, "Rename Tab…", "r", "renameActive", [.command, .shift])
    add(file, "Close Tab", "w", "closeActive")
    file.addItem(.separator())
    add(file, "Split Right…", "r", "splitRight")
    add(file, "Split Down…", "d", "splitDown")
    add(file, "Zoom Pane", "", "zoomPane")
    add(file, "Close Pane", "w", "closePane", [.command, .shift])
    install(file, at: 1)

    historyMenu.delegate = self
    rebuildHistoryMenu()
    install(historyMenu, at: main.items.firstIndex(where: { $0.title == "Window" }) ?? main.numberOfItems)

    // Native menu hints mirror Flutter; the shared picker owns all editing.
    if let edit = main.item(withTitle: "Edit")?.submenu {
      edit.addItem(.separator())
      add(edit, "Search Commands…", "p", "commands", [.command, .shift])
    }
    if let view = main.item(withTitle: "View")?.submenu {
      view.addItem(.separator())
      add(view, "Agents Needing Input…", "i", "notifications", [.command, .shift])
    }
    modelsMenu.autoenablesItems = false
    modelsMenu.delegate = self
    rebuildModelsMenu()
    install(modelsMenu, at: main.items.firstIndex(where: { $0.title == "Window" }) ?? main.numberOfItems)
    rebuildMachinesMenu()
    install(machinesMenu, at: main.items.firstIndex(where: { $0.title == "Window" }) ?? main.numberOfItems)
    installTerminalFindMenu(main)
  }

  func menuWillOpen(_ menu: NSMenu) {
    syncMenuKeys()
    if menu === historyMenu {
      for item in menu.items {
        guard let row = item.view as? SwarmHistoryMenuRow else { continue }
        item.isEnabled = validateMenuItem(item)
        row.setAccessibilityEnabled(item.isEnabled)
        row.needsDisplay = true
      }
    }
    guard menu === modelsMenu, actionsEnabled else { return }
    // The native menu opens from its cache. Network/credential reads happen
    // asynchronously in Dart and never hold up AppKit's menu tracking.
    channel.invokeMethod("modelsOpened", arguments: nil)
  }

  private func updateMachines(_ rows: [[String: Any]]) {
    let entries = rows.prefix(128).compactMap(SwarmMachineEntry.init)
    guard entries != machines else { return }
    machines = entries
    rebuildMachinesMenu()
  }

  private func rebuildMachinesMenu() {
    machinesMenu.removeAllItems()
    machinesMenu.minimumWidth = 0
    let labels = machines.map { machine -> (name: String, presence: String, status: String, count: String) in
      (name: SwarmMenuText.fitted(machine.name, width: 200),
       // Node presence ("Online"/"Offline"), shown grey right after the name,
       // independent of the link state on the trailing edge.
       presence: machine.presence,
       status: machine.status,
       count: machine.agentCount.map { "\($0) \($0 == 1 ? "harness" : "harnesses")" } ?? "")
    }
    // Preserve the compact menu's proportions, with the requested extra room.
    // Leading text = name + presence; trailing column = the agent count, or the
    // status word ("Link required"/"Offline"/…) when there is no count.
    let compactEdge = SwarmMenuText.trailingEdge(labels.map {
      ($0.presence.isEmpty ? $0.name : $0.name + "  " + $0.presence,
       $0.count.isEmpty ? $0.status : $0.count)
    })
    let trailingEdge = ceil((compactEdge + 62) * 1.2) - 62
    let manager = NSMenuItem(title: "Open Machines Manager", action: #selector(menuAction(_:)), keyEquivalent: "")
    manager.target = self
    manager.representedObject = "manageMachines"
    manager.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + "manageMachines")
    machinesMenu.addItem(manager)
    machinesMenu.addItem(.separator())
    for (machine, parts) in zip(machines, labels) {
      let item = NSMenuItem(title: machine.name, action: #selector(machineAction(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = machine.id
      let paragraph = NSMutableParagraphStyle()
      paragraph.tabStops = [NSTextTab(textAlignment: .right, location: trailingEdge)]
      let label = NSMutableAttributedString(string: parts.name,
        attributes: [.font: NSFont.menuFont(ofSize: 0), .paragraphStyle: paragraph])
      // After the name: the node presence ("Online"). Trailing (tab-aligned
      // right): the agent count, or the link/offline status when there is no
      // count. The two are independent slots, so a machine can read
      // "Online … Link required".
      let afterName = parts.presence.isEmpty ? "" : "  " + parts.presence
      let trailing = parts.count.isEmpty ? parts.status : parts.count
      label.append(NSAttributedString(string: afterName + "\t" + trailing,
        attributes: [.font: NSFont.menuFont(ofSize: 0), .paragraphStyle: paragraph,
          .foregroundColor: NSColor.secondaryLabelColor]))
      item.attributedTitle = label
      item.image = NSImage(systemSymbolName: machine.local ? "laptopcomputer" : "desktopcomputer", accessibilityDescription: nil)
      let submenu = NSMenu(title: machine.name)
      for agent in machine.agents {
        let child = NSMenuItem(title: agent.title, action: #selector(machineAgentAction(_:)), keyEquivalent: "")
        child.target = self
        child.representedObject = ["machineId": machine.id, "agentId": agent.id]
        child.image = historyIcons.image(engine: agent.engine, asset: agent.iconAsset)
        submenu.addItem(child)
      }
      if machine.agents.isEmpty {
        // Presence/online no longer rides in `status` (it moved to its own
        // slot). Link-required wins; a node known to be offline says so; a
        // reachable-or-connecting node is still fetching.
        let title: String
        if machine.agentCount == 0 {
          title = "No harnesses yet"
        } else if machine.linkRequired {
          title = "Link required"
        } else if machine.presence == "Offline" {
          title = "Offline"
        } else {
          title = "Loading harnesses…"
        }
        let empty = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        empty.isEnabled = false
        submenu.addItem(empty)
      }
      submenu.addItem(.separator())
      let find = NSMenuItem(title: "Find Harnesses…", action: #selector(machineAction(_:)), keyEquivalent: "")
      find.target = self
      find.representedObject = machine.id
      submenu.addItem(find)
      if !machine.local {
        submenu.addItem(.separator())
        let del = NSMenuItem(title: "Delete Machine…", action: #selector(machineDeleteAction(_:)), keyEquivalent: "")
        del.target = self
        del.representedObject = machine.id
        del.image = NSImage(systemSymbolName: "trash", accessibilityDescription: nil)
        submenu.addItem(del)
      }
      item.submenu = submenu
      machinesMenu.addItem(item)
    }
    if machines.isEmpty {
      let empty = NSMenuItem(title: "No Machines Linked", action: nil, keyEquivalent: "")
      empty.isEnabled = false
      machinesMenu.addItem(empty)
    }
    machinesMenu.addItem(.separator())
    for (title, action) in [("Link Machine…", "linkMachine"), ("Refresh Machines", "refreshMachines")] {
      let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = action
      item.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + action)
      machinesMenu.addItem(item)
    }
  }

  private func updateModels(_ rows: [[String: Any]]) {
    let entries = rows.prefix(32).compactMap(SwarmSubscriptionEntry.init)
    guard entries != subscriptions else { return }
    subscriptions = entries
    rebuildModelsMenu()
  }

  private func rebuildModelsMenu() {
    modelsMenu.removeAllItems()
    func label(_ title: String, in menu: NSMenu) {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.isEnabled = false
      menu.addItem(item)
    }
    func section(_ title: String) {
      if #available(macOS 14.0, *) {
        modelsMenu.addItem(NSMenuItem.sectionHeader(title: title))
      } else {
        label(title, in: modelsMenu)
      }
    }
    section("Subscription")
    let rowWidth = subscriptions.map(SwarmSubscriptionView.preferredWidth).max() ?? 352
    for entry in subscriptions {
      let item = NSMenuItem(title: entry.accessibilityLabel, action: nil, keyEquivalent: "")
      let icon = historyIcons.image(engine: entry.engine, asset: entry.iconAsset)
      item.view = SwarmSubscriptionView(entry: entry, icon: icon, width: rowWidth)
      item.isEnabled = false
      modelsMenu.addItem(item)
    }
    if subscriptions.isEmpty {
      label("Anthropic", in: modelsMenu)
      label("OpenAI", in: modelsMenu)
    }
    modelsMenu.addItem(.separator())
    section("API")
    label("OpenRouter", in: modelsMenu)
    label("fal.ai", in: modelsMenu)
    modelsMenu.addItem(.separator())
    section("Local")
    label("DeepSeek V4 Flash", in: modelsMenu)
    label("Qwen3.8-27B", in: modelsMenu)
    modelsMenu.addItem(.separator())
    label("Add Model", in: modelsMenu)
  }

  private func updateHistory(_ rows: [[String: Any]], closed: [[String: Any]] = []) {
    let entries = rows.prefix(64).compactMap(SwarmHistoryEntry.init)
    let closedEntries = closed.prefix(24).compactMap(SwarmHistoryEntry.init)
    guard entries != history || closedEntries != closedHistory else { return }
    history = entries
    closedHistory = closedEntries
    rebuildHistoryMenu()
  }

  private func rebuildHistoryMenu() {
    historyMenu.removeAllItems()
    historyMenu.minimumWidth = 0
    let visited = Array(history.prefix(15))
    let closed = Array(closedHistory.prefix(10))
    let trailingEdge = SwarmMenuText.trailingEdge((closed + visited).map { ($0.menuName, $0.menuMachine) })
    func command(_ title: String, _ key: String, _ action: String) {
      let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
      item.target = self
      item.representedObject = action
      item.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + action)
      item.keyEquivalentModifierMask = [.command]
      historyMenu.addItem(item)
    }
    command("Back", "[", "historyBack")
    command("Forward", "]", "historyForward")
    let reopen = NSMenuItem(title: "Reopen Last Closed", action: #selector(menuAction(_:)), keyEquivalent: "t")
    reopen.target = self
    reopen.representedObject = "reopen"
    reopen.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + "reopen")
    reopen.keyEquivalentModifierMask = [.command, .shift]
    historyMenu.addItem(reopen)
    historyMenu.addItem(.separator())
    appendHistorySection("Recently Closed", entries: closed, closed: true, trailingEdge: trailingEdge)
    historyMenu.addItem(.separator())
    appendHistorySection("Recently Visited", entries: visited, closed: false, trailingEdge: trailingEdge)
    historyMenu.addItem(.separator())
    command("Show Full History", "y", "showHistory")
    if let keymap { keymap.applyMenuKeys(to: historyMenu, context: flutterKeyContext) }
    let rowWidth = ceil(historyMenu.size.width * 1.2)
    historyMenu.minimumWidth = rowWidth
    for item in historyMenu.items {
      guard let id = item.representedObject as? String,
            let entry = (closed + visited).first(where: { $0.id == id }) else { continue }
      item.view = SwarmHistoryMenuRow(item: item, entry: entry, width: rowWidth)
    }
  }

  func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
    guard menu === historyMenu else { return }
    for row in menu.items {
      (row.view as? SwarmHistoryMenuRow)?.highlighted = row === item
    }
  }

  private func appendHistorySection(_ title: String, entries: [SwarmHistoryEntry], closed: Bool, trailingEdge: CGFloat) {
    if #available(macOS 14.0, *) {
      historyMenu.addItem(NSMenuItem.sectionHeader(title: title))
    } else {
      let label = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      label.isEnabled = false
      historyMenu.addItem(label)
    }
    for entry in entries {
      let title = entry.title.count > 76 ? String(entry.title.prefix(48)) + "…" + String(entry.title.suffix(24)) : entry.title
      let item = NSMenuItem(title: title, action: closed ? #selector(closedHistoryAction(_:)) : #selector(historyAction(_:)), keyEquivalent: "")
      item.attributedTitle = entry.menuTitle(trailingEdge: trailingEdge)
      item.target = self
      item.representedObject = entry.id
      item.state = entry.current ? .on : .off
      item.image = entry.swarm && entry.agentCount != 1
        ? SwarmIdentity.menuIcon
        : historyIcons.image(engine: entry.engine, asset: entry.iconAsset)
      historyMenu.addItem(item)
    }
    if entries.isEmpty {
      let item = NSMenuItem(title: closed ? "No Recently Closed Harnesses" : "No Recent Visits", action: nil, keyEquivalent: "")
      item.isEnabled = false
      historyMenu.addItem(item)
    }
  }

  private func installTerminalFindMenu(_ main: NSMenu) {
    guard let edit = main.items.first(where: { $0.title == "Edit" })?.submenu,
          let find = edit.items.first(where: { $0.title == "Find" }) else { return }
    let menu = NSMenu(title: "Find")
    for (title, key, action, modifiers) in [
      ("Find in Terminal…", "f", "findTerminal", NSEvent.ModifierFlags.command),
      ("Find Next", "g", "findNext", NSEvent.ModifierFlags.command),
      ("Find Previous", "g", "findPrevious", NSEvent.ModifierFlags([.command, .shift])),
    ] {
      let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
      item.keyEquivalentModifierMask = modifiers
      item.target = self
      item.representedObject = action
      item.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + action)
      menu.addItem(item)
    }
    // The template's find/replace actions target an unused text-editor handler.
    // Terminal output is searchable; replacement belongs to the running tool.
    find.submenu = menu
  }

  func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
    if menuItem.action == #selector(machineAgentAction(_:)) {
      guard actionsEnabled, let target = menuItem.representedObject as? [String: String],
            let machine = machines.first(where: { $0.id == target["machineId"] }) else { return false }
      return machine.agents.contains(where: { $0.id == target["agentId"] && $0.canOpen })
    }
    let action = menuItem.representedObject as? String ?? ""
    if menuItem.action == #selector(machineAction(_:)) {
      return actionsEnabled && machines.contains(where: { $0.id == action })
    }
    if menuItem.action == #selector(machineDeleteAction(_:)) {
      return actionsEnabled && machines.contains(where: { $0.id == action && !$0.local })
    }
    if menuItem.action == #selector(historyAction(_:)) {
      return actionsEnabled && history.contains(where: { $0.id == action })
    }
    if menuItem.action == #selector(closedHistoryAction(_:)) {
      return actionsEnabled && closedHistory.contains(where: { $0.id == action && $0.canReopen })
    }
    return actionsEnabled && (action != "reopen" || canReopen) &&
      (action != "historyBack" || canGoBack) && (action != "historyForward" || canGoForward) &&
      (action != "new" || canCreateSwarm) && (action != "closePane" || canClosePane) &&
      (!["findTerminal", "findNext", "findPrevious", "splitRight", "splitDown", "zoomPane", "pinPane"].contains(action) || canFind)
  }

  @objc private func menuAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let action = sender.representedObject as? String else { return }
    sendTabAction(action, arguments: nil)
  }

  @objc private func machineAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let id = sender.representedObject as? String else { return }
    sendTabAction("machineDestination", arguments: ["id": id])
  }

  @objc private func machineDeleteAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let id = sender.representedObject as? String else { return }
    sendTabAction("deleteMachine", arguments: ["id": id])
  }

  @objc private func machineAgentAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let target = sender.representedObject as? [String: String] else { return }
    sendTabAction("machineAgent", arguments: target)
  }

  @objc private func historyAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let id = sender.representedObject as? String else { return }
    channel.invokeMethod("historyDestination", arguments: ["id": id])
  }

  @objc private func closedHistoryAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let id = sender.representedObject as? String else { return }
    channel.invokeMethod("reopenHistory", arguments: ["id": id])
  }
}

private enum SwarmIdentity {
  // Same four separate tiles as widgets/swarm_icon.dart.
  static let menuIcon = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: nil)
}

private struct SwarmMachineEntry: Equatable {
  let id: String
  let name: String
  let status: String
  let presence: String
  let linkRequired: Bool
  let local: Bool
  let agentCount: Int?
  let agents: [SwarmMachineAgent]
  init?(_ row: [String: Any]) {
    guard let id = row["id"] as? String, !id.isEmpty,
          let name = row["name"] as? String, !name.isEmpty else { return nil }
    self.id = id
    self.name = String(name.prefix(128))
    status = String((row["status"] as? String ?? "").prefix(80))
    presence = String((row["presence"] as? String ?? "").prefix(80))
    linkRequired = row["linkRequired"] as? Bool == true
    local = row["local"] as? Bool == true
    agentCount = (row["agentCount"] as? Int).map { max(0, $0) }
    agents = (row["agents"] as? [[String: Any]] ?? []).prefix(512).compactMap(SwarmMachineAgent.init)
  }
}

private struct SwarmMachineAgent: Equatable {
  let id: String
  let title: String
  let engine: String?
  let iconAsset: String?
  let canOpen: Bool
  init?(_ row: [String: Any]) {
    guard let id = row["id"] as? String, !id.isEmpty,
          let title = row["title"] as? String, !title.isEmpty else { return nil }
    self.id = id
    self.title = String(title.prefix(160)).replacingOccurrences(of: "\n", with: " ")
    engine = row["engine"] as? String
    iconAsset = row["iconAsset"] as? String
    canOpen = row["canOpen"] as? Bool == true
  }
}

private struct SwarmSubscriptionEntry: Equatable {
  let title: String
  let account: String
  let status: String
  let details: [String]
  let engine: String?
  let iconAsset: String?

  init?(_ row: [String: Any]) {
    guard let title = row["title"] as? String, !title.isEmpty,
          let status = row["status"] as? String else { return nil }
    self.title = title
    account = row["account"] as? String ?? ""
    self.status = status
    details = Array((row["details"] as? [String] ?? [status]).prefix(16))
    engine = row["engine"] as? String
    iconAsset = row["iconAsset"] as? String
  }

  var accessibilityLabel: String {
    [title, account, status].filter { !$0.isEmpty }.joined(separator: ", ")
  }
}

/// Read-only account information, with aligned trailing balances. There is no
/// action or submenu to suggest another step just to read the remaining usage.
private final class SwarmSubscriptionView: NSView {
  private static let rowFont = NSFont.menuFont(ofSize: 0)
  let identity = NSTextField(labelWithString: "")
  let balance = NSTextField(labelWithString: "")
  private let icon = NSImageView()

  private static func textWidth(_ text: String) -> CGFloat {
    // Include the native text cell's horizontal drawing insets. Measuring only
    // glyphs or a label already constrained by its frame can clip the status.
    ceil((text as NSString).size(withAttributes: [.font: rowFont]).width) + 8
  }

  static func preferredWidth(_ entry: SwarmSubscriptionEntry) -> CGFloat {
    let identityWidth = textWidth(entry.title + "  " + entry.account)
    let balanceWidth = textWidth(entry.status)
    return min(576, max(352, identityWidth + balanceWidth + 88))
  }

  init(entry: SwarmSubscriptionEntry, icon: NSImage, width: CGFloat) {
    super.init(frame: NSRect(x: 0, y: 0, width: width, height: 26))
    autoresizingMask = [.width]
    self.icon.image = icon
    self.icon.imageScaling = .scaleProportionallyDown
    let title = NSMutableAttributedString(string: entry.title,
      attributes: [.font: Self.rowFont, .foregroundColor: NSColor.labelColor])
    if !entry.account.isEmpty {
      title.append(NSAttributedString(string: "  " + entry.account,
        attributes: [.font: Self.rowFont, .foregroundColor: NSColor.secondaryLabelColor]))
    }
    identity.attributedStringValue = title
    identity.usesSingleLineMode = true
    identity.lineBreakMode = .byTruncatingMiddle
    balance.stringValue = entry.status
    balance.font = Self.rowFont
    balance.textColor = .secondaryLabelColor
    balance.alignment = .right
    balance.usesSingleLineMode = true
    balance.lineBreakMode = .byClipping
    for view in [self.icon, identity, balance] {
      addSubview(view)
      view.setAccessibilityElement(false)
    }
    setAccessibilityElement(true)
    setAccessibilityRole(.staticText)
    setAccessibilityLabel(entry.accessibilityLabel)
    layout()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layout() {
    super.layout()
    icon.frame = NSRect(x: 16, y: (bounds.height - 16) / 2, width: 16, height: 16)
    let height = ceil(Self.rowFont.ascender - Self.rowFont.descender + Self.rowFont.leading)
    let balanceWidth = Self.textWidth(balance.stringValue)
    balance.frame = NSRect(x: bounds.width - 18 - balanceWidth,
      y: (bounds.height - height) / 2, width: balanceWidth, height: height)
    identity.frame = NSRect(x: 40, y: balance.frame.minY,
      width: max(0, balance.frame.minX - 24 - 40), height: height)
  }
}

/// A History row uses the full menu width; shortcut columns belong to commands.
/// Native item titles/actions still own type-select, validation and activation.
private final class SwarmHistoryMenuRow: NSView {
  private weak var item: NSMenuItem?
  private let entry: SwarmHistoryEntry
  var highlighted = false { didSet { needsDisplay = true } }
  var machineFrame: NSRect {
    let width = ceil(SwarmMenuText.width(entry.menuMachine))
    return NSRect(x: bounds.width - 18 - width, y: 4, width: width, height: 18)
  }

  init(item: NSMenuItem, entry: SwarmHistoryEntry, width: CGFloat) {
    self.item = item
    self.entry = entry
    super.init(frame: NSRect(x: 0, y: 0, width: width, height: 24))
    autoresizingMask = [.width]
    setAccessibilityElement(true)
    setAccessibilityRole(.menuItem)
    setAccessibilityLabel([entry.title, entry.machineName].filter { !$0.isEmpty }.joined(separator: ", "))
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    highlighted = false
    setAccessibilityEnabled(item?.isEnabled == true)
    needsDisplay = true
  }
  override func draw(_ dirtyRect: NSRect) {
    guard let item else { return }
    let selected = highlighted && item.isEnabled
    if selected {
      NSColor.selectedContentBackgroundColor.setFill()
      NSBezierPath(roundedRect: bounds.insetBy(dx: 4, dy: 0), xRadius: 5, yRadius: 5).fill()
    }
    let color = !item.isEnabled ? NSColor.disabledControlTextColor
      : selected ? .selectedMenuItemTextColor : .labelColor
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.menuFont(ofSize: 0), .foregroundColor: color]
    if item.state == .on {
      let mark = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)!
      let tinted = mark.copy() as! NSImage
      tinted.lockFocus()
      color.set()
      NSRect(origin: .zero, size: tinted.size).fill(using: .sourceAtop)
      tinted.unlockFocus()
      tinted.draw(in: NSRect(x: 7, y: 5, width: 13, height: 13))
    }
    if let icon = item.image {
      if icon.isTemplate, let tinted = icon.copy() as? NSImage {
        tinted.lockFocus()
        color.set()
        NSRect(origin: .zero, size: tinted.size).fill(using: .sourceAtop)
        tinted.unlockFocus()
        tinted.draw(in: NSRect(x: 25, y: 4, width: 16, height: 16))
      } else {
        icon.draw(in: NSRect(x: 25, y: 4, width: 16, height: 16))
      }
    }
    let right = entry.menuMachine.isEmpty ? bounds.width - 18 : machineFrame.minX - 20
    let name = SwarmMenuText.fitted(entry.title, width: max(0, right - 48))
    (name as NSString).draw(at: NSPoint(x: 48, y: 4), withAttributes: attributes)
    (entry.menuMachine as NSString).draw(at: machineFrame.origin, withAttributes: attributes)
  }
  override func mouseUp(with event: NSEvent) {
    guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
    activate()
  }
  override func accessibilityPerformPress() -> Bool { activate() }
  @discardableResult private func activate() -> Bool {
    guard let item, item.isEnabled, let menu = item.menu else { return false }
    let index = menu.index(of: item)
    guard index >= 0 else { return false }
    menu.cancelTracking()
    menu.performActionForItem(at: index)
    return true
  }
}

/// Keep native menu columns aligned without reserving a fixed, empty span.
private enum SwarmMenuText {
  static func width(_ text: String) -> CGFloat {
    (text as NSString).size(withAttributes: [.font: NSFont.menuFont(ofSize: 0)]).width
  }

  static func fitted(_ text: String, width limit: CGFloat) -> String {
    var value = text.replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " ")
    if width(value) <= limit { return value }
    while !value.isEmpty && width(value + "…") > limit { value.removeLast() }
    return value + "…"
  }

  static func trailingEdge(_ rows: [(String, String)]) -> CGFloat {
    let leading = rows.map { width($0.0) }.max() ?? 0
    let paired = rows.filter { !$0.1.isEmpty }
    let pairedLeading = paired.map { width($0.0) }.max() ?? 0
    let trailing = paired.map { width($0.1) }.max() ?? 0
    return ceil(max(leading, pairedLeading + (trailing > 0 ? 18 + trailing : 0)))
  }
}

private struct SwarmHistoryEntry: Equatable {
  let id: String
  let title: String
  let detail: String
  let machineName: String
  let swarm: Bool
  let agentCount: Int?
  let current: Bool
  let engine: String?
  let iconAsset: String?
  let canReopen: Bool
  var menuName: String { SwarmMenuText.fitted(title, width: machineName.isEmpty ? 330 : 250) }
  var menuMachine: String { SwarmMenuText.fitted(machineName, width: 110) }

  func menuTitle(trailingEdge: CGFloat? = nil) -> NSAttributedString {
    let font = NSFont.menuFont(ofSize: 0)
    let name = menuName
    let machine = menuMachine
    let paragraph = NSMutableParagraphStyle()
    paragraph.tabStops = [NSTextTab(textAlignment: .right,
      location: trailingEdge ?? SwarmMenuText.trailingEdge([(name, machine)]))]
    return NSAttributedString(string: machine.isEmpty ? name : name + "\t" + machine,
      attributes: [.font: font, .paragraphStyle: paragraph])
  }

  init?(_ row: [String: Any]) {
    guard let id = row["id"] as? String, let title = row["title"] as? String else { return nil }
    self.id = id
    self.title = title
    detail = row["detail"] as? String ?? ""
    machineName = row["machineName"] as? String ?? ""
    swarm = row["swarm"] as? Bool == true
    agentCount = row["agentCount"] as? Int
    current = row["current"] as? Bool == true
    engine = (row["engine"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    iconAsset = row["iconAsset"] as? String
    canReopen = row["canReopen"] as? Bool == true
  }
}

/// Reuse the same bundled engine artwork as pane headers. Each menu mark is
/// decoded once to at most 32 pixels, rather than retaining a full-size bitmap
/// or reopening assets on every history/focus update.
private final class SwarmHistoryIcons {
  private let cache = NSCache<NSString, NSImage>()
  private let assetURL: (String) -> URL?

  init(assetURL: @escaping (String) -> URL? = { asset in
    // Flutter ships desktop assets inside App.framework, not the runner bundle.
    let framework = Bundle.main.privateFrameworksURL?.appendingPathComponent("App.framework")
    let bundle = framework.flatMap { Bundle(url: $0) }
      ?? Bundle(identifier: "io.flutter.flutter.app")
      ?? Bundle.main
    return bundle.resourceURL?.appendingPathComponent("flutter_assets").appendingPathComponent(asset)
  }) {
    self.assetURL = assetURL
    cache.countLimit = 32
  }

  func image(engine: String?, asset: String?) -> NSImage {
    let id = engine?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    let key = "\(id):\(asset ?? "")" as NSString
    if let image = cache.object(forKey: key) { return image }
    let size = NSSize(width: 16, height: 16)
    let image: NSImage
    if let asset, asset.hasPrefix("assets/engine-icons/"),
       asset.hasSuffix(".png"), !asset.contains(".."),
       let url = assetURL(asset),
       let source = CGImageSourceCreateWithURL(url as CFURL, nil),
       let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
         kCGImageSourceCreateThumbnailFromImageAlways: true,
         kCGImageSourceCreateThumbnailWithTransform: true,
         kCGImageSourceThumbnailMaxPixelSize: 32,
         kCGImageSourceShouldCacheImmediately: true,
       ] as CFDictionary) {
      let bitmap = NSImage(cgImage: thumbnail, size: .zero)
      let scale = 16 / CGFloat(max(thumbnail.width, thumbnail.height))
      let width = CGFloat(thumbnail.width) * scale
      let height = CGFloat(thumbnail.height) * scale
      image = NSImage(size: size, flipped: false) { _ in
        bitmap.draw(in: NSRect(x: (16 - width) / 2, y: (16 - height) / 2, width: width, height: height))
        return true
      }
    } else if id == "claude" {
      // Same four round strokes, proportions and orange as EngineMark.
      image = NSImage(size: size, flipped: false) { _ in
        NSColor(srgbRed: 204.0 / 255, green: 124.0 / 255, blue: 94.0 / 255, alpha: 1).setStroke()
        let path = NSBezierPath()
        path.lineWidth = 16 * 0.098
        path.lineCapStyle = .round
        for i in 0..<4 {
          let angle = CGFloat(i) * .pi / 4
          let dx = 16 * 0.39 * cos(angle), dy = 16 * 0.39 * sin(angle)
          path.move(to: NSPoint(x: 8 - dx, y: 8 - dy))
          path.line(to: NSPoint(x: 8 + dx, y: 8 + dy))
        }
        path.stroke()
        return true
      }
    } else {
      image = NSImage(size: size, flipped: false) { _ in
        let initial = String(id.first ?? "A").uppercased() as NSString
        let attributes: [NSAttributedString.Key: Any] = [
          .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .bold),
          .foregroundColor: NSColor.black,
        ]
        let bounds = initial.size(withAttributes: attributes)
        initial.draw(at: NSPoint(x: (16 - bounds.width) / 2, y: (16 - bounds.height) / 2), withAttributes: attributes)
        return true
      }
      image.isTemplate = true
    }
    cache.setObject(image, forKey: key)
    return image
  }
}

private let swarmPasteboardType = NSPasteboard.PasteboardType("ai.autonomous.harness.v2.swarm")
/// Dart's palette is authoritative. These defaults match Graphite before its
/// first snapshot arrives; every window retains its own resolved colors.
private struct SwarmNativePalette: Equatable {
  let tabBar: NSColor
  let workspace: NSColor
  let search: NSColor
  let accent: NSColor

  init(_ values: [String: Any] = [:]) {
    func color(_ name: String, _ fallback: UInt32) -> NSColor {
      let supplied = values[name] as? Int64
      let valid = supplied.map { $0 >= 0 && $0 <= Int64(UInt32.max) && ($0 >> 24) == 255 } ?? false
      let argb = valid ? UInt32(supplied!) : fallback
      return NSColor(srgbRed: CGFloat((argb >> 16) & 255) / 255,
        green: CGFloat((argb >> 8) & 255) / 255, blue: CGFloat(argb & 255) / 255, alpha: 1)
    }
    tabBar = color("tabBar", 0xff1c1c1c)
    workspace = color("workspace", 0xff282828)
    search = color("search", 0xff2c2c2c)
    accent = color("accent", 0xffbdcbdc)
  }
}

/// Match the quiet rounded hover well used by the app's pane controls.
private class SwarmIconButton: NSButton {
  private var hovered = false
  private(set) var hasKeyboardFocus = false
  var showsHoverFill: Bool { true }
  override var acceptsFirstResponder: Bool { isEnabled }
  override var mouseDownCanMoveWindow: Bool { false }
  override var isEnabled: Bool {
    didSet {
      needsDisplay = true
      window?.invalidateCursorRects(for: self)
    }
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: .zero,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }
  override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
  override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }
  override func resetCursorRects() {
    super.resetCursorRects()
    if isEnabled { addCursorRect(bounds, cursor: .pointingHand) }
  }
  override func becomeFirstResponder() -> Bool {
    guard super.becomeFirstResponder() else { return false }
    hasKeyboardFocus = true
    needsDisplay = true
    return true
  }
  override func resignFirstResponder() -> Bool {
    guard super.resignFirstResponder() else { return false }
    hasKeyboardFocus = false
    needsDisplay = true
    return true
  }
  override func draw(_ dirtyRect: NSRect) {
    if showsHoverFill && isEnabled && (hovered || hasKeyboardFocus || isHighlighted) {
      NSColor.white.withAlphaComponent(isHighlighted ? 0.10 : 0.05).setFill()
      NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7).fill()
    }
    super.draw(dirtyRect)
  }
}

private final class SwarmNotificationButton: SwarmIconButton {
  var hasAttention = false { didSet { needsDisplay = true } }
  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    if hasAttention {
      NSColor.systemOrange.setFill()
      NSBezierPath(ovalIn: NSRect(x: bounds.midX + 4, y: bounds.midY + 5, width: 5, height: 5)).fill()
    }
  }
}

/// Keep titlebar actions on the app's palette. AppKit's rounded bezel chooses
/// its own label color in active/inactive windows, ignoring contentTintColor.
private final class SwarmActionButton: NSButton {
  var fillColor = NSColor.clear { didSet { needsDisplay = true } }
  var borderColor: NSColor? { didSet { needsDisplay = true } }
  var labelColor = NSColor.labelColor { didSet { needsDisplay = true } }
  private var hovered = false
  override var isEnabled: Bool {
    didSet {
      needsDisplay = true
      window?.invalidateCursorRects(for: self)
    }
  }
  override var mouseDownCanMoveWindow: Bool { false }

  override func resetCursorRects() {
    super.resetCursorRects()
    if isEnabled { addCursorRect(bounds, cursor: .pointingHand) }
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: .zero,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }
  override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
  override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }

  override func draw(_ dirtyRect: NSRect) {
    // A workspace modal dims the canvas, not this native chrome. Keep the
    // normal appearance while isEnabled still prevents actions behind it.
    let emphasis: CGFloat = isHighlighted ? 0.16 : 0.08
    let hoverFill = fillColor.alphaComponent == 0
      ? labelColor.withAlphaComponent(emphasis)
      : fillColor.blended(withFraction: emphasis, of: labelColor) ?? fillColor
    let fill = isEnabled && (hovered || isHighlighted) ? hoverFill : fillColor
    fill.setFill()
    NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
    if let borderColor {
      borderColor.setStroke()
      let border = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
        xRadius: (bounds.height - 1) / 2, yRadius: (bounds.height - 1) / 2)
      border.lineWidth = 1
      border.stroke()
    }
    let label = NSAttributedString(string: title, attributes: [
      .font: font ?? NSFont.systemFont(ofSize: 12, weight: .medium),
      .foregroundColor: labelColor,
    ])
    let size = label.size()
    let iconWidth: CGFloat = image == nil ? 0 : 20
    let left = (bounds.width - size.width - iconWidth) / 2
    image?.withSymbolConfiguration(NSImage.SymbolConfiguration(paletteColors: [labelColor]))?
      .draw(in: NSRect(x: left, y: (bounds.height - 14) / 2, width: 14, height: 14))
    label.draw(at: NSPoint(x: left + iconWidth, y: (bounds.height - size.height) / 2))
  }
}

private final class SwarmTabStrip: NSView {
  private(set) var palette = SwarmNativePalette()
  var emit: ((String, Any?) -> Void)?
  private let scroll = NSScrollView()
  private let document = NSView()
  fileprivate let newButton = SwarmIconButton()
  fileprivate let notificationButton = SwarmNotificationButton()
  fileprivate let openButton = SwarmActionButton()
  fileprivate let createButton = SwarmActionButton()
  private var tabs: [SwarmTabButton] = []
  private let icons = SwarmHistoryIcons()
  private var activeId = ""
  private var revealActiveAfterLayout = false
  private var tabOrderChanged = false
  private var actionsEnabled = false
  private var lastBackgroundClick: (time: TimeInterval, point: NSPoint)?
  // Hold ⌘ and each of the first nine tabs shows the digit that reaches it
  // (⌘1…⌘9, the app's own bindings) — the same discoverability Safari and
  // the terminals give their tabs. Off again the moment ⌘ is released or the
  // app goes to the background.
  private var commandHeld = false
  private var flagsMonitor: Any?
  private var resignObserver: NSObjectProtocol?
  override var mouseDownCanMoveWindow: Bool { true }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    flagsMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      self?.setCommandHeld(event.modifierFlags.contains(.command))
      return event
    }
    resignObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.setCommandHeld(false) }
    scroll.drawsBackground = false
    scroll.hasHorizontalScroller = false
    scroll.hasVerticalScroller = false
    scroll.documentView = document
    addSubview(scroll)
    func button(_ button: NSButton, _ symbol: String, _ label: String, _ action: Selector) {
      button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
      button.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
      button.isBordered = false
      button.title = ""
      button.imagePosition = .imageOnly
      button.contentTintColor = palette.accent
      button.target = self
      button.action = action
      button.setAccessibilityLabel(label)
      addSubview(button)
    }
    button(newButton, "plus", "New Tab", #selector(newSwarm))
    newButton.setAccessibilityLabel("New Tab")
    newButton.isEnabled = false
    button(notificationButton, "bell", "Notifications", #selector(openNotifications))
    notificationButton.isEnabled = false
    func textButton(_ button: NSButton, _ label: String, _ action: Selector) {
      button.title = label
      button.font = .systemFont(ofSize: 12, weight: .medium)
      button.isBordered = false
      button.setButtonType(.momentaryChange)
      button.target = self
      button.action = action
      button.setAccessibilityLabel(label)
      button.isEnabled = false
      addSubview(button)
    }
    textButton(createButton, "New Harness", #selector(createAgent))
    textButton(openButton, "Open Harness", #selector(openHarness))
    createButton.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)
    openButton.image = NSImage(systemSymbolName: "arrow.up.right", accessibilityDescription: nil)
    updateActionColors()
    setAccessibilityChildren([notificationButton, scroll, newButton, createButton, openButton])
    registerForDraggedTypes([swarmPasteboardType])
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func updatePalette(_ values: [String: Any]) {
    let nextPalette = SwarmNativePalette(values)
    guard nextPalette != palette else { return }
    palette = nextPalette
    notificationButton.contentTintColor = palette.accent
    newButton.contentTintColor = palette.accent
    updateActionColors()
    for tab in tabs { tab.palette = palette }
    needsDisplay = true
  }

  private func updateActionColors() {
    createButton.fillColor = palette.accent
    createButton.labelColor = palette.tabBar
    openButton.fillColor = .clear
    openButton.labelColor = palette.accent
    openButton.borderColor = palette.accent.withAlphaComponent(0.3)
  }

  deinit {
    if let flagsMonitor { NSEvent.removeMonitor(flagsMonitor) }
    if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
  }

  private func setCommandHeld(_ held: Bool) {
    guard commandHeld != held else { return }
    commandHeld = held
    applyShortcutBadges()
  }

  fileprivate func applyShortcutBadges() {
    for (index, tab) in tabs.enumerated() {
      tab.shortcut = commandHeld && actionsEnabled && index < 9 ? index + 1 : nil
    }
  }

  func update(_ state: [String: Any]) {
    // Workspace teardown clears its controls without changing appearance.
    if let palette = state["palette"] as? [String: Any] { updatePalette(palette) }
    actionsEnabled = state["enabled"] as? Bool == true
    let rows = state["tabs"] as? [[String: Any]] ?? []
    let nextActiveId = state["activeId"] as? String ?? ""
    revealActiveAfterLayout = revealActiveAfterLayout || nextActiveId != activeId
    activeId = nextActiveId
    let ids = rows.compactMap { $0["id"] as? String }
    let previousOrder = tabs.map(\.swarmId)
    tabOrderChanged = tabOrderChanged || ids != previousOrder
    for tab in tabs where !ids.contains(tab.swarmId) { tab.removeFromSuperview() }
    let previous = Dictionary(uniqueKeysWithValues: tabs.map { ($0.swarmId, $0) })
    tabs = rows.compactMap { row in
      guard let id = row["id"] as? String else { return nil }
      let tab = previous[id] ?? SwarmTabButton(id: id)
      tab.palette = palette
      tab.name = row["name"] as? String ?? "New Tab"
      let count = row["agentCount"] as? Int ?? 0
      // The Harness Store tab holds no agents; without its own mark it would wear New Tab's plus.
      let store = row["kind"] as? String == "store"
      tab.icon = store
        ? icons.image(engine: "store", asset: row["iconAsset"] as? String)
        : count == 1
        ? icons.image(engine: row["engine"] as? String, asset: row["iconAsset"] as? String)
        : count > 1
        ? SwarmIdentity.menuIcon
        : NSImage(systemSymbolName: "plus", accessibilityDescription: "New Tab")
      tab.selected = id == activeId
      tab.actionsEnabled = actionsEnabled
      tab.attention = (row["attention"] as? Int ?? 0) > 0
      tab.emit = { [weak self, weak tab] method, args in
        guard let self, let tab, self.actionsEnabled,
              self.tabs.contains(where: { $0 === tab }) else { return }
        self.emit?(method, args)
      }
      tab.hoverChanged = { [weak self] in self?.updateDividers() }
      if tab.superview == nil { document.addSubview(tab) }
      tab.needsDisplay = true
      return tab
    }
    updateDividers()
    applyShortcutBadges()
    // Moving frames alone leaves AppKit's child traversal in insertion order.
    document.setAccessibilityChildren(tabs)
    newButton.isEnabled = actionsEnabled && (state["canOpenNewTab"] as? Bool ?? (tabs.count < 24))
    notificationButton.isEnabled = actionsEnabled
    openButton.isEnabled = actionsEnabled
    createButton.isEnabled = actionsEnabled
    let attention = state["attention"] as? Int ?? 0
    notificationButton.hasAttention = attention > 0
    notificationButton.setAccessibilityLabel(attention > 0 ? "\(attention) agents need input" : "Notifications")
    needsLayout = true
    layoutSubtreeIfNeeded()
    if ids != previousOrder {
      NSAccessibility.post(element: document, notification: .layoutChanged)
    }
  }

  private func updateDividers() {
    for (index, tab) in tabs.enumerated() {
      let next = index + 1 < tabs.count ? tabs[index + 1] : nil
      tab.showsDivider = !tab.selected && !tab.isHovered && next != nil &&
        next?.selected == false && next?.isHovered == false
    }
  }

  override func layout() {
    super.layout()
    let active = tabs.first(where: { $0.swarmId == activeId })
    let activeWasVisible = active.map { scroll.documentVisibleRect.intersects($0.frame) } ?? false
    let previousScrollSize = scroll.frame.size
    let previousDocumentSize = document.frame.size
    let leading: CGFloat = 36
    let spacious = bounds.width >= 480
    let openWidth: CGFloat = spacious ? 122 : 108
    let trailing: CGFloat = spacious ? 12 : 8
    let actionsWidth = openWidth * 2 + 10 + trailing
    newButton.isHidden = bounds.width < 420
    // A reserve after the "+" that tabs never grow into — Chrome's gap. It is
    // where a full strip can still be dragged and double-clicked to zoom
    // (owner, 2026-09-15); tabs shrink and then scroll instead of taking it.
    let grip: CGFloat = spacious ? 84 : 44
    let available = max(32, bounds.width - leading - actionsWidth - (newButton.isHidden ? 0 : 36) - grip)
    let width = min(220, max(min(132, available), available / CGFloat(max(1, tabs.count))))
    let occupied = min(available, CGFloat(tabs.count) * width)
    scroll.frame = NSRect(x: leading, y: 0, width: occupied, height: bounds.height)
    document.frame = NSRect(x: 0, y: 0, width: max(occupied, CGFloat(tabs.count) * width), height: bounds.height)
    for (index, tab) in tabs.enumerated() {
      tab.frame = NSRect(x: CGFloat(index) * width, y: 0, width: width, height: bounds.height - 6)
      tab.contentCenterY = bounds.midY
    }
    let buttonY = (bounds.height - 28) / 2
    notificationButton.frame = NSRect(x: 0, y: buttonY, width: 28, height: 28)
    newButton.frame = NSRect(x: leading + occupied + 4, y: buttonY, width: 28, height: 28)
    let actionY = (bounds.height - 34) / 2
    openButton.frame = NSRect(x: bounds.width - trailing - openWidth, y: actionY, width: openWidth, height: 34)
    createButton.frame = NSRect(x: openButton.frame.minX - 10 - openWidth, y: actionY, width: openWidth, height: 34)
    let geometryChanged = scroll.frame.size != previousScrollSize || document.frame.size != previousDocumentSize
    if let active, revealActiveAfterLayout || (activeWasVisible && (geometryChanged || tabOrderChanged)) {
      document.scrollToVisible(active.frame)
    }
    revealActiveAfterLayout = false
    tabOrderChanged = false
  }
  override func draw(_ dirtyRect: NSRect) {
    // The selected tab meets this edge; its bottom corners are shoulders,
    // rather than the rounded bottom of a separate pill.
    palette.workspace.setFill()
    NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()

  }
  override func mouseDown(with event: NSEvent) {
    // A double-click on the strip's background zooms the window. This is the
    // one place that does: the Flutter bar under the strip only drags, since
    // its own double-tap zoomed a second time, straight back (owner,
    // 2026-09-15: "maximizes out and resizes back").
    if ownsBackgroundDoubleClick(event) { window?.performZoom(nil) }
    else if event.clickCount == 1 { window?.performDrag(with: event) }
  }
  fileprivate func ownsBackgroundDoubleClick(_ event: NSEvent) -> Bool {
    if event.clickCount == 1 {
      lastBackgroundClick = (event.timestamp, event.locationInWindow)
      return false
    }
    guard event.clickCount == 2, let first = lastBackgroundClick else {
      lastBackgroundClick = nil
      return false
    }
    lastBackgroundClick = nil
    return event.timestamp - first.time <= NSEvent.doubleClickInterval &&
      hypot(event.locationInWindow.x - first.point.x,
            event.locationInWindow.y - first.point.y) <= 4
  }
  @objc private func newSwarm() {
    if actionsEnabled && newButton.isEnabled { emit?("new", nil) }
  }
  @objc private func openNotifications() {
    if actionsEnabled { emit?("notifications", nil) }
  }
  @objc private func openHarness() {
    if actionsEnabled { emit?("addAgent", nil) }
  }
  @objc private func createAgent() {
    if actionsEnabled { emit?("newAgent", nil) }
  }

  private func draggedTab(_ sender: NSDraggingInfo) -> SwarmTabButton? {
    guard actionsEnabled, sender.draggingSourceOperationMask.contains(.move),
          let source = sender.draggingSource as? SwarmTabButton,
          tabs.contains(where: { $0 === source }),
          sender.draggingPasteboard.string(forType: swarmPasteboardType) == source.swarmId,
          scroll.frame.contains(convert(sender.draggingLocation, from: nil)) else { return nil }
    return source
  }
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { draggedTab(sender) == nil ? [] : .move }
  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { draggedTab(sender) == nil ? [] : .move }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    guard let source = draggedTab(sender), let old = tabs.firstIndex(where: { $0 === source }) else { return false }
    let point = document.convert(sender.draggingLocation, from: nil)
    let index = tabs.firstIndex(where: { point.x < $0.frame.midX }) ?? tabs.count
    let destination = max(0, index > old ? index - 1 : index)
    if destination != old { emit?("reorder", ["id": source.swarmId, "index": destination]) }
    return true
  }
}

private final class SwarmTabButton: NSView, NSDraggingSource, NSMenuItemValidation {
  var palette = SwarmNativePalette() {
    didSet { if palette != oldValue { needsDisplay = true } }
  }
  let swarmId: String
  var name = "New Tab" { didSet { if name != oldValue { invalidateLabel(); updateAccessibility() } } }
  var selected = false { didSet { if selected != oldValue { invalidateLabel(); updateAccessibility() } } }
  var attention = false { didSet { if attention != oldValue { needsDisplay = true; updateAccessibility() } } }
  var showsDivider = false { didSet { if showsDivider != oldValue { needsDisplay = true } } }
  /// The ⌘-digit that selects this tab, shown while ⌘ is held; nil otherwise.
  var shortcut: Int? { didSet { if shortcut != oldValue { updateCloseVisibility(); needsDisplay = true } } }
  var contentCenterY: CGFloat = 20
  var emit: ((String, Any?) -> Void)?
  var hoverChanged: (() -> Void)?
  var isHovered: Bool { hovered && actionsEnabled }
  private let closeButton = SwarmCloseButton()
  private let selectButton = SwarmSelectButton()
  private let iconView = NSImageView()
  var icon: NSImage? {
    get { iconView.image }
    set { iconView.image = newValue }
  }
  private var cachedLabel: NSAttributedString?
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
    iconView.imageScaling = .scaleProportionallyDown
    iconView.contentTintColor = NSColor(white: 0.85, alpha: 1)
    iconView.setAccessibilityElement(false)
    addSubview(iconView)
    selectButton.owner = self
    closeButton.owner = self
    selectButton.title = ""
    selectButton.isBordered = false
    selectButton.target = self
    selectButton.action = #selector(selectSwarm)
    addSubview(selectButton)
    closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close Tab")
    closeButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold)
    closeButton.contentTintColor = NSColor(white: 0.78, alpha: 1)
    closeButton.isBordered = false
    closeButton.target = self
    closeButton.action = #selector(closeSwarm)
    addSubview(closeButton)
    let menu = NSMenu()
    for (title, action) in [("Rename Tab…", #selector(renameSwarm)), ("Close Tab", #selector(closeSwarm))] {
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
    iconView.frame = NSRect(x: 22, y: contentCenterY - 8, width: 16, height: 16)
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
  override func mouseEntered(with event: NSEvent) { setHovered(true) }
  override func mouseExited(with event: NSEvent) { setHovered(false) }
  private func setHovered(_ value: Bool) {
    guard hovered != value else { return }
    hovered = value
    updateCloseVisibility()
    needsDisplay = true
    hoverChanged?()
  }
  fileprivate func updateCloseVisibility() {
    // The badge borrows the close glyph's slot; while ⌘ is held the digit wins.
    closeButton.showsGlyph = shortcut == nil
      && (hovered || selectButton.hasKeyboardFocus || closeButton.hasKeyboardFocus)
  }
  private func invalidateLabel() {
    cachedLabel = nil
    needsDisplay = true
  }
  private var label: NSAttributedString {
    if let cachedLabel { return cachedLabel }
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    let label = NSAttributedString(string: name,
      attributes: [.font: NSFont.systemFont(ofSize: 13, weight: selected ? .medium : .regular),
        .foregroundColor: selected ? NSColor.white : NSColor(white: 0.76, alpha: 1), .paragraphStyle: paragraph])
    cachedLabel = label
    return label
  }
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
      palette.workspace.setFill()
      shape.fill()
    } else if hovered && actionsEnabled {
      NSColor(white: 1, alpha: 0.05).setFill()
      let hoverRect = NSRect(x: 8, y: contentCenterY - 14, width: bounds.width - 16, height: 28)
      NSBezierPath(roundedRect: hoverRect, xRadius: 12, yRadius: 12).fill()
    }
    if showsDivider && !hovered {
      NSColor(white: 1, alpha: 0.16).setFill()
      NSBezierPath(roundedRect: NSRect(x: bounds.width - 0.5, y: contentCenterY - 8, width: 1, height: 16),
        xRadius: 0.5, yRadius: 0.5).fill()
    }
    let label = self.label
    let labelHeight = label.size().height
    label.draw(in: NSRect(x: 46, y: contentCenterY - labelHeight / 2,
      width: bounds.width - 88, height: labelHeight))
    if attention {
      NSColor.systemOrange.setFill()
      NSBezierPath(ovalIn: NSRect(x: 13, y: contentCenterY - 2, width: 4, height: 4)).fill()
    }
    if let shortcut {
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .right
      let badge = NSAttributedString(string: "⌘\(shortcut)",
        attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium),
          .foregroundColor: NSColor(white: 1, alpha: selected ? 0.7 : 0.5), .paragraphStyle: paragraph])
      let badgeHeight = badge.size().height
      badge.draw(in: NSRect(x: bounds.width - 46, y: contentCenterY - badgeHeight / 2, width: 32, height: badgeHeight))
    }
  }
  // Overflowed tabs might not be drawn. Their names and selection still need
  // to be available to VoiceOver and automation before they scroll into view.
  private func updateAccessibility() {
    setAccessibilityLabel(name)
    selectButton.setAccessibilityLabel("Select \(name)")
    selectButton.setAccessibilityValue(selected ? "Selected" : "")
    selectButton.setAccessibilityHelp(attention ? "Contains agents needing input" : nil)
    closeButton.setAccessibilityLabel("Close \(name)")
  }
  func validateMenuItem(_ menuItem: NSMenuItem) -> Bool { actionsEnabled }
  override func mouseDown(with event: NSEvent) {
    guard actionsEnabled else { return }
    downPoint = event.locationInWindow
    if event.clickCount == 2 { renameSwarm() }
    else { emit?("select", ["id": swarmId]) }
  }
  // The tab owns the full click sequence, including clicks on its padding.
  // Forwarding mouseUp lets AppKit also treat a rename as a titlebar zoom.
  override func mouseUp(with event: NSEvent) {}
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
private class SwarmTabActionButton: SwarmIconButton {
  weak var owner: SwarmTabButton?
  override var showsHoverFill: Bool { false }
  override func becomeFirstResponder() -> Bool {
    guard super.becomeFirstResponder() else { return false }
    owner?.updateCloseVisibility()
    if let owner { owner.scrollToVisible(owner.bounds) }
    return true
  }
  override func resignFirstResponder() -> Bool {
    guard super.resignFirstResponder() else { return false }
    owner?.updateCloseVisibility()
    return true
  }
}

/// Keep the close action reachable by keyboard and VoiceOver while its glyph
/// rests quietly. Reserving its space avoids shifting labels on hover.
private final class SwarmCloseButton: SwarmTabActionButton {
  override var showsHoverFill: Bool { true }
  var showsGlyph = false { didSet { if showsGlyph != oldValue { needsDisplay = true } } }
  override func draw(_ dirtyRect: NSRect) {
    if showsGlyph { super.draw(dirtyRect) }
  }
}

private final class SwarmSelectButton: SwarmTabActionButton {
  override func mouseDown(with event: NSEvent) {
    guard isEnabled else { return }
    owner?.mouseDown(with: event)
  }
  override func mouseUp(with event: NSEvent) {}
  override func mouseDragged(with event: NSEvent) {
    guard isEnabled else { return }
    owner?.mouseDragged(with: event)
  }
}
