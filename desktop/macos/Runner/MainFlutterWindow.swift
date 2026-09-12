import Cocoa
import FlutterMacOS

/// Channel the app menu talks to Dart over.
///
/// One-way: AppKit reports that a menu item fired, Dart decides what that
/// means. Nothing about updating lives on this side.
private let kMenuChannel = "harness/app_menu"

/// Channel Dart calls INTO this side over, to read a native image off the general pasteboard.
/// Flutter's own `Clipboard` API only ever sees `text/plain` — see `terminal_panel.dart`'s
/// `_paste()` — so a real image (a screenshot, "Copy Image" from a browser, ...) needs this native
/// round trip instead. The other direction of `harness/clipboard_image` (Dart calling Swift) rather
/// than `harness/app_menu`'s (Swift calling Dart).
private let kClipboardImageChannel = "harness/clipboard_image"

class MainFlutterWindow: NSWindow {
  private var swarmTitlebar: SwarmTitlebar?
  private var menuChannel: FlutterMethodChannel?
  private var clipboardImageChannel: FlutterMethodChannel?

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)

    menuChannel = FlutterMethodChannel(
      name: kMenuChannel,
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    swarmTitlebar = SwarmTitlebar(window: self, messenger: flutterViewController.engine.binaryMessenger)
    installClipboardImageChannel(messenger: flutterViewController.engine.binaryMessenger)

    // Harness Desktop is dark-only. Flutter's own theme does not reach AppKit —
    // every native surface (the standard About panel, the menu bar, the
    // window's title bar and its traffic lights, any AppKit sheet) follows
    // `NSApp.appearance`, not `MaterialApp.theme` — so it is pinned here once
    // rather than left to whatever the Mac's own Appearance setting is, which
    // would otherwise paint a dark app with a light About panel and title bar.
    NSApp.appearance = NSAppearance(named: .darkAqua)

    installAppMenuItems()
    installViewMenuItems()
    takeOverAboutItem()

    super.awakeFromNib()
  }

  /// Show "Version 1.0.4" in the About box instead of "Version 1.0.4 (10004)".
  ///
  /// The build number is a release-pipeline artefact — upload-desktop.sh derives
  /// an integer from the version because `flutter build --build-number` demands
  /// one — and it means nothing to the person reading it, nor to this app, which
  /// compares releases by CFBundleShortVersionString everywhere else.
  ///
  /// Making the two Info.plist keys AGREE does not do it: the panel then reads
  /// "Version 1.0.4 (1.0.4)". AppKit's own header is explicit about the way out
  /// — NSAboutPanelOptionVersion is the BUILD half, "if not specified or empty
  /// string, leave blank" — so the fix is to open the standard panel ourselves
  /// with that half blanked, and leave Info.plist alone.
  ///
  /// The item is retargeted rather than replaced, so it keeps its place, its
  /// title and its localisation from the nib.
  private func takeOverAboutItem() {
    guard let appMenu = NSApp.mainMenu?.item(at: 0)?.submenu else { return }
    // Matched by selector NAME rather than `#selector(...)`. AppKit declares
    // several `orderFrontStandardAboutPanel` overloads, so the literal form is
    // ambiguous enough that the compiler offers a fix-it for a DIFFERENT method
    // — and a mismatch here fails silently: the guard falls through, the item
    // keeps its stock action, and the About box quietly keeps its parenthesis.
    guard let about = appMenu.items.first(where: {
      $0.action.map(NSStringFromSelector) == "orderFrontStandardAboutPanel:"
    }) else { return }
    about.target = self
    about.action = #selector(showAbout(_:))
  }

  @objc private func showAbout(_ sender: Any?) {
    NSApp.orderFrontStandardAboutPanel(options: [.version: ""])
  }

  /// Puts the app's own two commands in the application menu, below Show All.
  ///
  /// Added here rather than in MainMenu.xib so the whole menu bar keeps coming
  /// from the nib — declaring it in Dart with PlatformMenuBar would replace the
  /// bar wholesale, taking Edit and Window with it, and with them the standard
  /// Cut/Copy/Paste shortcuts a terminal window needs.
  private func installAppMenuItems() {
    guard let appMenu = NSApp.mainMenu?.item(at: 0)?.submenu else { return }
    // awakeFromNib can run more than once if the nib is reloaded; a second
    // pass must not stack duplicate rows onto the menu.
    guard appMenu.indexOfItem(withTag: flashMenuItemTag) == -1 else { return }

    // Inserted at one index in order, so the list reads top to bottom.
    let at = insertionIndex(in: appMenu)
    // A shortcut sheet nobody can find is a sheet nobody reads. This row is
    // the way in with a mouse, and — because AppKit prints the key equivalent
    // beside it — the way people learn ⌘/ in the first place.
    appMenu.insertItem(
      menuItem(
        title: "Keyboard Shortcuts…",
        action: #selector(showShortcuts(_:)),
        symbol: "keyboard",
        tag: shortcutsMenuItemTag,
        keyEquivalent: "/"
      ),
      at: at
    )
    appMenu.insertItem(NSMenuItem.separator(), at: at + 1)
    appMenu.insertItem(
      menuItem(
        title: "Flash Firmware…",
        action: #selector(flashFirmware(_:)),
        symbol: "bolt.circle",
        tag: flashMenuItemTag
      ),
      at: at + 2
    )

  }

  /// The Safari/Chrome/Terminal.app "Font" convention, in the SAME menu and the SAME order those
  /// apps use it in — this is deliberately a NATIVE menu, not a row in Dart's own ⌘/ sheet: AppKit
  /// already owns "View" in the menu bar, already prints the key equivalent beside each item, and
  /// a native key equivalent is handled by the responder chain before Flutter's own keyboard
  /// handling ever sees the event — a Dart-side `CallbackShortcuts` binding on the same chord would
  /// never fire once this exists, so there is exactly one implementation, not two.
  private func installViewMenuItems() {
    guard let viewMenu = NSApp.mainMenu?.item(withTitle: "View")?.submenu else { return }
    guard viewMenu.indexOfItem(withTag: layoutMenuItemTag) == -1 else { return }

    // Terminal.app's own View menu keeps its font-size trio well above Enter Full Screen, in its
    // own bracketed section. The nib's "Enter Full Screen" must stay LAST — appending after it
    // (the previous approach) put this section in the wrong place relative to that convention, so
    // this inserts before it instead. Matched by ACTION alone (not `indexOfItem(withTarget:
    // andAction:)`, which requires an EXACT target match — the nib wires this to Interface
    // Builder's First Responder placeholder, which does not reliably read back as a literal `nil`
    // target here) — same reason insertionIndex(in:) below matches by action too: a first-responder
    // action survives menu-bar localization, a hardcoded index does not.
    //
    // No leading separator is added here: AppKit's own automatic window-tabbing injection
    // ("Show Tab Bar"/"Show All Tabs", enabled by default and not opted out of anywhere in this
    // project) always leaves its own separator directly above "Enter Full Screen" — but it runs on
    // its own schedule, at some point AFTER this method (observed empirically: a second, adjacent
    // separator added here shows up doubled, because this method's own insertion point is computed
    // before that injection happens). Matching Terminal.app's spacing this way, by omission, is more
    // reliable than trying to race or detect AppKit's exact timing.
    let fullScreenIndex = viewMenu.items.firstIndex {
      $0.action == #selector(NSWindow.toggleFullScreen(_:))
    }
    var at = fullScreenIndex ?? viewMenu.numberOfItems

    // The grid's shape, and the only way to it with a mouse. It was reachable
    // by ⌘L alone at first, which is the same mistake the shortcut sheet's own
    // comment describes above: a command nobody can see is a command nobody
    // uses — and worse here, the native terminal holds the keyboard, so the
    // Dart-side binding does not even fire while a pane has focus. As a native
    // key equivalent it is handled by the responder chain first, so it works
    // wherever the focus happens to be.
    //
    // ⌘S, matching the Dart binding. It was still "l" here after that binding moved, and this side is
    // the one that wins: AppKit takes the key equivalent before Flutter ever sees the event, so ⌘L went
    // on opening the layout palette and ⌘S did nothing inside a terminal — the exact silent conflict
    // the shortcut table's own comment warns about.
    viewMenu.insertItem(
      menuItem(
        title: "Layout…",
        action: #selector(showLayout(_:)),
        symbol: "square.grid.2x2",
        tag: layoutMenuItemTag,
        keyEquivalent: "s"
      ),
      at: at
    )
    at += 1
    viewMenu.insertItem(NSMenuItem.separator(), at: at)
    at += 1
    viewMenu.insertItem(
      menuItem(
        title: "Default Font Size",
        action: #selector(resetTerminalFontSize(_:)),
        symbol: "textformat.size",
        tag: resetFontMenuItemTag,
        keyEquivalent: "0"
      ),
      at: at
    )
    at += 1
    viewMenu.insertItem(
      menuItem(
        title: "Bigger",
        action: #selector(increaseTerminalFontSize(_:)),
        symbol: "character",
        tag: biggerFontMenuItemTag,
        // "+" (not "=") is the literal string AppKit's own zoom-style menus use — it renders as ⌘+
        // and, since the default keyEquivalentModifierMask has no .shift in it, still fires on the
        // plain, easy-to-reach ⌘= keypress, matching Safari/Chrome/Terminal.app exactly.
        keyEquivalent: "+"
      ),
      at: at
    )
    at += 1
    viewMenu.insertItem(
      menuItem(
        title: "Smaller",
        action: #selector(decreaseTerminalFontSize(_:)),
        symbol: "character",
        tag: smallerFontMenuItemTag,
        keyEquivalent: "-"
      ),
      at: at
    )
    at += 1
    viewMenu.insertItem(NSMenuItem.separator(), at: at)
  }

  private func menuItem(
    title: String,
    action: Selector,
    symbol: String,
    tag: Int,
    keyEquivalent: String = ""
  ) -> NSMenuItem {
    let item = NSMenuItem(
      title: title,
      action: action,
      keyEquivalent: keyEquivalent
    )
    item.target = self
    item.tag = tag
    // Every other row in this menu carries a glyph, so one without reads as
    // unfinished — the gutter stays but nothing sits in it.
    item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
    return item
  }

  /// Just below Show All.
  ///
  /// Located by ACTION, not by title: the titles in this menu are localised by
  /// AppKit, so "Show All" only matches while the user runs an English system.
  private func insertionIndex(in appMenu: NSMenu) -> Int {
    let showAll = appMenu.indexOfItem(
      withTarget: nil,
      andAction: #selector(NSApplication.unhideAllApplications(_:))
    )
    if showAll >= 0 { return showAll + 1 }
    let byTitle = appMenu.indexOfItem(withTitle: "Show All")
    if byTitle >= 0 { return byTitle + 1 }
    // Nothing recognisable to anchor to — sit above Quit rather than vanish.
    return max(appMenu.numberOfItems - 1, 0)
  }

  private var updateMenuItemTag: Int { 7301 }
  private var flashMenuItemTag: Int { 7302 }
  private var shortcutsMenuItemTag: Int { 7303 }
  private var resetFontMenuItemTag: Int { 7304 }
  private var biggerFontMenuItemTag: Int { 7305 }
  private var smallerFontMenuItemTag: Int { 7306 }
  private var layoutMenuItemTag: Int { 7307 }

  @objc private func checkForUpdates(_ sender: Any?) {
    menuChannel?.invokeMethod("checkForUpdates", arguments: nil)
  }

  @objc private func flashFirmware(_ sender: Any?) {
    menuChannel?.invokeMethod("flashFirmware", arguments: nil)
  }

  @objc private func showLayout(_ sender: Any?) {
    menuChannel?.invokeMethod("showLayout", arguments: nil)
  }

  @objc private func showShortcuts(_ sender: Any?) {
    menuChannel?.invokeMethod("showShortcuts", arguments: nil)
  }

  @objc private func increaseTerminalFontSize(_ sender: Any?) {
    menuChannel?.invokeMethod("increaseTerminalFontSize", arguments: nil)
  }

  @objc private func decreaseTerminalFontSize(_ sender: Any?) {
    menuChannel?.invokeMethod("decreaseTerminalFontSize", arguments: nil)
  }

  @objc private func resetTerminalFontSize(_ sender: Any?) {
    menuChannel?.invokeMethod("resetTerminalFontSize", arguments: nil)
  }

  private func installClipboardImageChannel(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: kClipboardImageChannel, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      switch call.method {
      case "readImagePng":
        result(MainFlutterWindow.readClipboardImagePng())
      case "writeImagePng":
        guard let bytes = (call.arguments as? FlutterStandardTypedData)?.data else {
          result(FlutterError(code: "INVALID_ARGUMENT", message: "expected PNG bytes", details: nil))
          return
        }
        result(MainFlutterWindow.writeClipboardImagePng(bytes))
      default:
        result(FlutterMethodNotImplemented)
      }
    }
    clipboardImageChannel = channel
  }

  /// Reads the general pasteboard for image data, returned as PNG bytes — or `nil` when the
  /// clipboard holds no image (the normal case for a plain-text paste, which the caller is
  /// expected to fall back to). Prefers an existing PNG representation; falls back to TIFF (what
  /// "Copy Image" from Safari, Preview, and many other apps actually put on the pasteboard),
  /// re-encoded to PNG since the terminal wire protocol only carries one image format.
  private static func readClipboardImagePng() -> FlutterStandardTypedData? {
    let pasteboard = NSPasteboard.general
    if let pngData = pasteboard.data(forType: .png) {
      return FlutterStandardTypedData(bytes: pngData)
    }
    guard let tiffData = pasteboard.data(forType: .tiff),
      let bitmap = NSBitmapImageRep(data: tiffData),
      let pngData = bitmap.representation(using: .png, properties: [:])
    else {
      return nil
    }
    return FlutterStandardTypedData(bytes: pngData)
  }

  /// Writes PNG bytes onto the general pasteboard, replacing whatever was there — the LOCAL half
  /// of native image drag-drop (`_dropImage` in pane_grid.dart): when the pane's machine is this
  /// same computer, the app puts the dropped image on ITS OWN clipboard directly instead of
  /// sending it over the terminal wire, then forwards a Ctrl+V so the engine reads it exactly as
  /// it already does for an ordinary local clipboard paste.
  private static func writeClipboardImagePng(_ data: Data) -> Bool {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    return pasteboard.setData(data, forType: .png)
  }
}
