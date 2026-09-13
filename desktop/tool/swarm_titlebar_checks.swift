
// Appended to SwarmTitlebar.swift by check_swarm_titlebar.sh. Same-file
// extensions can inspect private controls without exposing them in the app API.
private struct TitlebarCheckFailure: Error {
  let message: String
}

private var titlebarCheckCount = 0
private func checkTitlebar(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  guard condition() else { throw TitlebarCheckFailure(message: message) }
  titlebarCheckCount += 1
}

private extension SwarmTabButton {
  func checkAccessibility(expectedName: String, active: Bool) throws {
    try checkTitlebar(accessibilityLabel() == expectedName, "Tab group name is available before paint")
    let children = accessibilityChildren()?.compactMap { $0 as? NSButton } ?? []
    try checkTitlebar(children.count == 2, "Selection and close are separate accessible buttons")
    try checkTitlebar(children[0].accessibilityLabel() == "Select \(expectedName)", "Selection button has current name")
    try checkTitlebar(children[0].accessibilityValue() as? String == (active ? "Selected" : ""), "Selection value is current")
    try checkTitlebar(children[1].accessibilityLabel() == "Close \(expectedName)", "Close button has current name")
  }

  func checkEnabled(_ enabled: Bool) throws {
    try checkTitlebar(selectButton.isEnabled == enabled, "Select button obeys modal state")
    try checkTitlebar(closeButton.isEnabled == enabled, "Close button obeys modal state")
    for item in menu?.items ?? [] {
      try checkTitlebar(validateMenuItem(item) == enabled, "Tab context menu obeys modal state")
    }
  }

  func clickBothActions() {
    selectButton.performClick(nil)
    closeButton.performClick(nil)
  }
}

private extension SwarmTabStrip {
  func checkActiveVisible() throws {
    guard let active = tabs.first(where: { $0.swarmId == activeId }) else {
      throw TitlebarCheckFailure(message: "Selected tab exists")
    }
    let visible = scroll.documentVisibleRect
    try checkTitlebar(active.frame.minX >= visible.minX - 1, "Selected tab's leading edge is visible after layout")
    try checkTitlebar(active.frame.maxX <= visible.maxX + 1, "Selected tab's trailing edge is visible after layout")
  }

  func runChecks() throws {
    let rows = (0..<24).map { ["id": "swarm-\($0)", "name": "Swarm \($0)"] }
    var events: [String] = []
    emit = { method, _ in events.append(method) }
    func state(_ rows: [[String: String]], active: String, enabled: Bool = true) -> [String: Any] {
      ["tabs": rows, "activeId": active, "enabled": enabled, "attention": 2]
    }
    update(state(rows, active: "swarm-11"))
    try checkTitlebar(tabs.count == 24, "All overflow tabs exist")
    try checkTitlebar(!newButton.isEnabled, "New tab is disabled at capacity")
    for (index, tab) in tabs.enumerated() {
      try tab.checkAccessibility(expectedName: "Swarm \(index)", active: index == 11)
    }
    try checkActiveVisible()
    setFrameSize(NSSize(width: 320, height: 40))
    needsLayout = true
    layoutSubtreeIfNeeded()
    try checkActiveVisible()

    let original = tabs[0]
    let reversed = Array(rows.reversed())
    update(state(reversed, active: "swarm-0"))
    try checkTitlebar(tabs.last === original, "Reordering retains existing tab controls")
    try checkTitlebar(tabs.map(\.swarmId) == reversed.map { $0["id"]! }, "Tab order follows the saved Swarm order")
    let accessibleTabs = document.accessibilityChildren()?.compactMap { $0 as? SwarmTabButton } ?? []
    try checkTitlebar(accessibleTabs.map(\.swarmId) == tabs.map(\.swarmId), "Accessible tab order follows visual order after reordering")
    try checkActiveVisible()

    update(state([["id": "swarm-0", "name": "Renamed tab"]], active: "swarm-0"))
    try checkTitlebar(tabs.count == 1 && tabs[0] === original, "Closing tabs retains the surviving control")
    try original.checkAccessibility(expectedName: "Renamed tab", active: true)
    try checkTitlebar(newButton.isEnabled, "New tab returns below capacity")
    try checkTitlebar(notifications.accessibilityLabel() == "2 agents need input", "Attention has a readable accessible label")
    try original.checkEnabled(true)
    original.clickBothActions()
    try checkTitlebar(events == ["select", "close"], "Native selection and close dispatch once each")

    events.removeAll()
    update(state([["id": "swarm-0", "name": "Renamed tab"]], active: "swarm-0", enabled: false))
    try original.checkEnabled(false)
    try checkTitlebar(!newButton.isEnabled && !notifications.isEnabled && !settings.isEnabled, "Titlebar actions disable with a modal")
    original.clickBothActions()
    newButton.performClick(nil)
    notifications.performClick(nil)
    settings.performClick(nil)
    try checkTitlebar(events.isEmpty, "Disabled controls emit no actions")
  }
}

let titlebarCheckApp = NSApplication.shared
titlebarCheckApp.setActivationPolicy(.prohibited)
titlebarCheckApp.appearance = NSAppearance(named: .darkAqua)
do {
  let strip = SwarmTabStrip(frame: NSRect(x: 0, y: 0, width: 900, height: 40))
  try strip.runChecks()
  try checkTitlebar(titlebarCheckApp.windows.isEmpty, "Checks never open an application window")
  print("AppKit Swarm titlebar: \(titlebarCheckCount) checks passed; no windows opened.")
} catch {
  let message = (error as? TitlebarCheckFailure)?.message ?? String(describing: error)
  FileHandle.standardError.write(Data("AppKit Swarm titlebar failed: \(message)\n".utf8))
  exit(1)
}
