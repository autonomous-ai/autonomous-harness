// An isolated WKWebView probe with the desktop pane's JavaScript/media settings.
// Arguments: forwarded URL, JavaScript readiness expression, output PNG. This is
// native WebKit coverage, not a launch of the complete Flutter desktop app.
import AppKit
import WebKit

guard CommandLine.arguments.count == 4,
      let url = URL(string: CommandLine.arguments[1]) else {
    fatalError("Usage: viewer-webkit URL readiness-expression screenshot.png")
}
let expression = CommandLine.arguments[2]
let output = CommandLine.arguments[3]
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
configuration.mediaTypesRequiringUserActionForPlayback = []
let webview = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 800), configuration: configuration)
let window = NSWindow(contentRect: webview.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Harness remote viewer validation"
window.contentView = webview
window.orderFront(nil)
var finished = false
var pending = false
let deadline = Date().addingTimeInterval(90)
func finish(_ success: Bool, _ message: String) {
    guard !finished else { return }
    finished = true
    webview.takeSnapshot(with: nil) { snapshot, _ in
        if let snapshot = snapshot,
           let cgImage = snapshot.cgImage(forProposedRect: nil, context: nil, hints: nil),
           let png = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: output))
        }
        print("\(success ? "PASS" : "FAIL") WKWebView: \(message)")
        fflush(stdout)
        exit(success ? 0 : 1)
    }
}
class Navigation: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(false, error.localizedDescription)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(false, error.localizedDescription)
    }
}
let navigation = Navigation()
webview.navigationDelegate = navigation
webview.load(URLRequest(url: url))
let timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
    guard !finished, !pending else { return }
    if Date() > deadline { finish(false, "readiness timed out"); return }
    pending = true
    webview.evaluateJavaScript(expression) { value, _ in
        pending = false
        if let ready = value as? Bool, ready { finish(true, "viewer ready") }
    }
}
app.run()
