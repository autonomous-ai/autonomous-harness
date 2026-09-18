// Compiled after HarnessKeymap.swift by check_keymap_native.sh.
struct KeymapCheckFailure: Error { let message: String }
var keymapChecks = 0
func checkKeymap(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  guard condition() else { throw KeymapCheckFailure(message: message) }
  keymapChecks += 1
}
func stroke(_ key: String) -> HarnessKeyStroke { HarnessKeyStroke(key)! }

let source = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let fixture = try JSONSerialization.jsonObject(with: source) as! [String: [String: Any]]
let defaults = HarnessNativeKeymap(fixture["defaults"]!)!
let changed = HarnessNativeKeymap(fixture["changed"]!)!
for (key, command) in [
  ("cmd+left", "pane.focus_left"), ("cmd+down", "pane.focus_below"),
  ("cmd+up", "pane.focus_above"), ("cmd+right", "pane.focus_right"),
  ("cmd+s", "pane.layout"), ("cmd+r", "pane.split_right"),
  ("cmd+d", "pane.split_down"),
  ("cmd+b", "task.route"), ("cmd+t", "swarm.new"),
  ("cmd+p", "project.orchestrate"),
  ("cmd+o", "agent.add"), ("cmd+n", "agent.new"),
  ("cmd+h", "pane.focus_left"), ("cmd+j", "pane.focus_below"),
  ("cmd+k", "pane.focus_above"), ("cmd+l", "pane.focus_right"),
] {
  try checkKeymap(defaults.match([stroke(key)], context: "workspace").binding?.command == command,
    "Preserve the current default for \(key)")
}
try checkKeymap(defaults.viewerOrchestratorCommand(stroke("cmd+p")) == "project.orchestrate",
  "A focused native viewer can open the orchestrator")
try checkKeymap(defaults.viewerOrchestratorCommand(stroke("cmd+b")) == nil,
  "The viewer bridge does not change single-agent routing")
try checkKeymap(defaults.viewerOrchestratorCommand(stroke("cmd+shift+p")) == nil,
  "The viewer bridge does not take the command palette chord")
for context in ["workspace", "terminal", "picker"] {
  try checkKeymap(defaults.match([stroke("cmd+shift+n")], context: context).binding == nil,
    "Shift-Command-N is unbound by default in \(context)")
  for number in 1...9 {
    try checkKeymap(defaults.match([stroke("cmd+\(number)")], context: context).binding?.command == "swarm.select_\(number)",
      "Command-number selects the corresponding tab from \(context)")
  }
}
for context in ["workspace", "terminal", "picker"] {
  try checkKeymap(changed.match([stroke("cmd+t")], context: context).binding == nil,
    "Native context honors inherited unbinding")
  let search = changed.match([stroke("cmd+o")], context: context).binding
  try checkKeymap(search?.command == "swarm.new" && search?.hint == "⌘O" && search?.menuAction == "new",
    "The new key, menu owner and displayed hint agree")
  try checkKeymap(changed.match([stroke("cmd+k")], context: context).prefix,
    "User sequence prefix replaces the shorter command")
}
try checkKeymap(changed.match([stroke("cmd+left")], context: "terminal").binding == nil,
  "Terminal-only unbinding does not leak its workspace binding")
try checkKeymap(changed.match([stroke("cmd+left")], context: "workspace").binding != nil,
  "Workspace keeps its own context")
try checkKeymap(changed.match([stroke("down")], context: "picker").binding == nil,
  "Picker unbinding removes the original arrow action")
try checkKeymap(changed.match([stroke("ctrl+j")], context: "picker").binding?.command == "picker.previous",
  "Picker remapping wins")
try checkKeymap(defaults.match([stroke("cmd+i")], context: "picker").binding == nil,
  "Always-on preview does not consume a hide-preview shortcut")
for (key, command) in [("pageup", "picker.preview_page_up"), ("pagedown", "picker.preview_page_down")] {
  try checkKeymap(defaults.match([stroke(key)], context: "picker").binding?.command == command,
    "Preview paging follows the exported Search binding")
  for context in ["workspace", "terminal"] {
    try checkKeymap(defaults.match([stroke(key)], context: context).binding == nil,
      "Preview paging leaves \(context) input alone")
  }
}

let dispatcher = HarnessNativeKeyDispatch(changed)
let field = NSObject(), otherField = NSObject()
func send(_ key: String?, _ code: UInt16 = 1, repeated: Bool = false, composing: Bool = false,
          owner: NSObject = field, context: String = "picker", modifier: Bool = false,
          executable: Bool = true) -> (handled: Bool, command: String?) {
  dispatcher.dispatch(key.map(stroke), keyCode: code, repeated: repeated, modifier: modifier,
    composing: composing, context: context, owner: owner, canExecute: { _ in executable })
}
try checkKeymap(send("cmd+k").handled && dispatcher.pending.count == 1, "Prefix is claimed synchronously")
try checkKeymap(send("cmd+k", repeated: true).command == nil && dispatcher.pending.count == 1,
  "A held prefix does not advance a sequence")
try checkKeymap(!send(nil, 2, modifier: true).handled && dispatcher.pending.count == 1,
  "Modifiers retain normal delivery during a prefix")
try checkKeymap(send("cmd+n", 3).command == "swarm.new" && dispatcher.pending.isEmpty,
  "Completing a sequence dispatches exactly one named command")
try checkKeymap(dispatcher.release(3) && !dispatcher.release(3), "Consumed key-up is paired once")
_ = send("cmd+k")
try checkKeymap(send("x", 4).handled && dispatcher.pending.isEmpty,
  "A failed sequence is consumed rather than typed into an agent")
try checkKeymap(!send("x", 4).handled, "The next ordinary character is not swallowed")
_ = send("cmd+k")
try checkKeymap(send("escape", 5).handled && dispatcher.pending.isEmpty, "Escape cancels a prefix")
_ = send("cmd+k")
try checkKeymap(!send("x", 4, owner: otherField).handled && dispatcher.pending.isEmpty,
  "A different input owner cannot complete the previous field's sequence")
_ = send("cmd+k")
try checkKeymap(!send("enter", 6, composing: true).handled && dispatcher.pending.isEmpty,
  "IME composition keeps input and cancels the prefix")
try checkKeymap(send("cmd+o", executable: false).handled && send("cmd+o", executable: false).command == nil,
  "An unavailable mapped action cannot fall through as input")
try checkKeymap(send("cmd+o", repeated: true).command == nil, "Search does not repeat")
try checkKeymap(send("ctrl+j", repeated: true).command == "picker.previous", "Result movement repeats")
try checkKeymap(send("pagedown", repeated: true).command == "picker.preview_page_down",
  "Holding a preview paging key continues scrolling")
_ = send("cmd+k")
dispatcher.suspend()
try checkKeymap(dispatcher.pending.isEmpty && !dispatcher.release(1), "Window blur clears pending and held keys")
dispatcher.update(defaults)
try checkKeymap(send("cmd+t").command == "swarm.new", "Reload installs the new resolved map")

try checkKeymap(HarnessKeyStroke.fromCharacters("H", modifiers: [.command, .capsLock]) == stroke("cmd+h"),
  "Caps Lock does not change a Command binding")
try checkKeymap(HarnessKeyStroke.fromCharacters("1", modifiers: [.command, .shift]) == stroke("cmd+shift+1"),
  "Shift stays in modifiers after layout translation")
try checkKeymap(HarnessKeyStroke.fromCharacters("\u{f702}", modifiers: .command) == stroke("cmd+left"),
  "AppKit arrow characters map to the same logical keys")
try checkKeymap(HarnessKeyStroke.fromCharacters("\u{f72d}", modifiers: [.function, .numericPad]) == stroke("pagedown"),
  "Mac Fn navigation maps to preview paging without an extra modifier")
try checkKeymap(HarnessKeyStroke.fromCharacters("木", modifiers: []) == nil,
  "Unsupported composed text is not guessed as a QWERTY key")
try checkKeymap(stroke("cmd+shift+left").menuEquivalent == "\u{f702}" && stroke("f24").menuEquivalent == "\u{f71b}",
  "Native menu equivalents preserve function keys")

func payload(_ rows: [[String: Any]]) -> [String: Any] {
  ["version": 1, "contexts": ["workspace": rows, "terminal": rows, "picker": rows]]
}
let prefix: [String: Any] = ["keys": ["cmd+k"], "command": "example", "hint": "⌘K", "repeatable": false]
let remappedOrchestrator = HarnessNativeKeymap(payload([
  ["keys": ["cmd+y"], "command": "project.orchestrate", "hint": "⌘Y", "repeatable": false],
]))!
try checkKeymap(remappedOrchestrator.viewerOrchestratorCommand(stroke("cmd+p")) == nil &&
  remappedOrchestrator.viewerOrchestratorCommand(stroke("cmd+y")) == "project.orchestrate",
  "Native viewers respect an orchestrator shortcut remap")
let sequence: [String: Any] = ["keys": ["cmd+k", "cmd+n"], "command": "example", "hint": "⌘K ⌘N", "repeatable": false]
try checkKeymap(HarnessNativeKeymap(payload([prefix, sequence])) == nil, "Reject ambiguous prefixes atomically")
try checkKeymap(HarnessNativeKeymap(payload([prefix, prefix])) == nil, "Reject duplicate strokes atomically")
try checkKeymap(HarnessNativeKeymap(payload(Array(repeating: prefix, count: 641))) == nil, "Bound incoming binding counts")
try checkKeymap(HarnessNativeKeymap(["version": 2, "contexts": [:]]) == nil, "Reject unsupported snapshots")
for value in ["cmd+cmd+h", "cmd+", "cmd+not-a-key", "ctrl+alt+shift+cmd+fn+p", "f01"] {
  try checkKeymap(HarnessKeyStroke(value) == nil, "Reject malformed native stroke \(value)")
}
print("Native keyboard bridge: \(keymapChecks) checks passed against Dart's exported bindings; no windows or agents opened.")
