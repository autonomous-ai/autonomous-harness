import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import '../core/models.dart' show AgentVerdict;
import '../core/test_run.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../state/terminal_pane.dart';
import '../theme/app_theme.dart';
import 'engine_identity.dart';
import 'pane_header_actions.dart';
import 'verdict_marks.dart';

/// A domain harness's viewer, in a tile beside its agent's terminal.
///
/// The page is the harness's own — Circuit's board workspace, Workshop's 3D
/// view — served by a process the daemon runs on the agent's machine. This
/// panel only frames it: a header in the terminal's own idiom, a webview
/// that follows [TerminalPane.url] when the daemon names a new one, and a
/// small notice while the viewer is not answering yet.
///
/// The webview is a native view (WKWebView through `webview_flutter`), and a
/// native view cannot exist where no platform implementation is registered:
/// under `flutter test`, and on Linux today. There the body is the URL in
/// words, so every layout around it still builds and the tests can prove the
/// tile is placed, sized and closed correctly without instantiating it.
class WebPanePanel extends StatefulWidget {
  const WebPanePanel({
    super.key,
    required this.notifier,
    required this.pane,
    required this.ownerName,
    required this.ownerEngine,
    this.ownerDisplayName,
    this.verdict,
    this.working = false,
    this.onClose,
    this.onToggleZoom,
    this.zoomed = false,
    this.compactHeader = false,
  });

  final AppNotifier notifier;
  final TerminalPane pane;

  /// The agent this viewer belongs to, for the header.
  final String ownerName;
  final String? ownerEngine;
  final String? ownerDisplayName;

  /// The harness's verdict on the workspace this viewer shows, for the phase
  /// strip and the chip in the header. The viewer IS the product, so this
  /// header carries them in full where the terminal's shows only the chip.
  final AgentVerdict? verdict;

  /// The agent is mid-turn: the header says so instead of the last verdict.
  final bool working;
  final VoidCallback? onClose;
  final VoidCallback? onToggleZoom;
  final bool zoomed;
  final bool compactHeader;

  /// Whether this build can put a real webview on screen. One place, so the
  /// panel and its tests agree on when the placeholder is the right answer.
  static bool get webviewAvailable => !kUnderTest && Platform.isMacOS;

  @override
  State<WebPanePanel> createState() => _WebPanePanelState();
}

class _WebPanePanelState extends State<WebPanePanel> {
  WebViewController? _controller;
  String? _loadedUrl;
  bool _loading = false;
  String? _failure;

  @override
  void initState() {
    super.initState();
    if (WebPanePanel.webviewAvailable) _mountController();
  }

  void _mountController() {
    // WebKit's default media policy wants a click before any playback, which
    // leaves a viewer's muted video sitting at 00:00 with a play button; a
    // pane whose whole point is the render the harness just made autoplays it.
    final controller = WebViewController.fromPlatformCreationParams(
      WebViewPlatform.instance is WebKitWebViewPlatform
          ? WebKitWebViewControllerCreationParams(
              allowsInlineMediaPlayback: true,
              mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
            )
          : const PlatformWebViewControllerCreationParams(),
    )
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageStarted: (_) => _set(() {
            _loading = true;
            _failure = null;
          }),
          onPageFinished: (_) => _set(() => _loading = false),
          onWebResourceError: (error) {
            // Only the page itself: a harness's viewer pulls fonts, models
            // and images of its own, and one of those failing is its business
            // to show, not ours to call a dead viewer.
            if (error.isForMainFrame == false) return;
            _set(() {
              _loading = false;
              _failure = error.description.isNotEmpty
                  ? error.description
                  : 'The viewer did not answer.';
            });
          },
        ),
      );
    _controller = controller;
    _load();
  }

  void _set(VoidCallback change) {
    if (mounted) setState(change);
  }

  void _load() {
    final url = widget.pane.url;
    final controller = _controller;
    if (url == null || controller == null) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    _loadedUrl = url;
    _failure = null;
    // The window colour behind the page, so a dark app never flashes white
    // while a viewer loads. WKWebView on macOS has no such setting (the plugin
    // throws UnimplementedError, seen live 2026-09-15 as a red pane), so only
    // platforms that do get it.
    if (!Platform.isMacOS) {
      controller.setBackgroundColor(grid.AppPalette.windowBg);
    }
    controller.loadRequest(uri);
  }

  void _reload() {
    if (_controller == null) return;
    if (_loadedUrl != widget.pane.url) {
      _load();
    } else {
      _failure = null;
      _controller!.reload();
    }
    setState(() {});
  }

  @override
  void didUpdateWidget(WebPanePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The daemon named a different page — the newest artifact, a viewer
    // restarted on another port. Navigate in place; the tile stays.
    if (widget.pane.url != _loadedUrl) _load();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ColoredBox(
      color: grid.AppPalette.windowBg,
      child: Column(
        children: [
          _header(context),
          Divider(height: 1, color: AppColors.border),
          Expanded(child: _body(context)),
        ],
      ),
    );
  }

  Widget _header(BuildContext context) {
    final compact = widget.compactHeader;
    return PaneHeaderHover(
      child: SizedBox(
        height: compact ? 38 : 46,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(
            children: [
              EngineMark(
                engine: widget.ownerEngine,
                displayName: widget.ownerDisplayName,
                size: 17,
              ),
              const SizedBox(width: 10),
              // The name, and one status after it — ready, or what stands in
              // the way, or where the work is — in the place a "Viewer" label
              // would only repeat what the pane shows. A status, not a history.
              Expanded(
                child: Tooltip(
                  message: widget.pane.url ?? '',
                  waitDuration: const Duration(milliseconds: 700),
                  child: Row(
                    children: [
                      Flexible(
                        child: Text(
                          widget.ownerName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: AppColors.text,
                            fontFamily: AppFonts.sans,
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      if (widget.verdict case final verdict?) ...[
                        Text(
                          '  ·  ',
                          style: TextStyle(
                            color: AppColors.mutedStrong,
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        Flexible(
                          child: VerdictStatus(
                            verdict: verdict,
                            working: widget.working,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 6),
                  child: SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(strokeWidth: 1.5),
                  ),
                ),
              _ViewerActions(
                zoomed: widget.zoomed,
                onReload: _controller == null ? null : _reload,
                onZoom: widget.onToggleZoom,
                onClose: widget.onClose,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final controller = _controller;
    final url = widget.pane.url;
    if (controller == null) {
      return _Notice(
        key: const ValueKey('web-pane-placeholder'),
        icon: LucideIcons.globe,
        title: 'Viewer',
        detail: url ?? 'No viewer yet.',
      );
    }
    return Stack(
      fit: StackFit.expand,
      children: [
        WebViewWidget(controller: controller),
        if (_failure != null)
          ColoredBox(
            color: grid.AppPalette.windowBg,
            child: _Notice(
              icon: LucideIcons.unplug,
              title: 'Waiting for the viewer',
              detail: _failure!,
              action: TextButton(
                onPressed: _reload,
                child: const Text('Retry'),
              ),
            ),
          ),
      ],
    );
  }
}

/// Reload, zoom, close — the terminal header's controls, minus the one that
/// ends an agent, because a viewer has no agent to end. Same 28px buttons,
/// same hover reveal ([PaneHeaderHover]), so the two headers read as one kind.
class _ViewerActions extends StatelessWidget {
  const _ViewerActions({
    required this.zoomed,
    this.onReload,
    this.onZoom,
    this.onClose,
  });

  final bool zoomed;
  final VoidCallback? onReload, onZoom, onClose;

  @override
  Widget build(BuildContext context) {
    Widget action(String tooltip, IconData icon, VoidCallback? callback) =>
        IconButton(
          tooltip: tooltip,
          onPressed: callback,
          icon: Icon(icon, size: 16),
          style: ButtonStyle(
            fixedSize: const WidgetStatePropertyAll(Size(28, 28)),
            minimumSize: const WidgetStatePropertyAll(Size(28, 28)),
            padding: const WidgetStatePropertyAll(EdgeInsets.zero),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            visualDensity: VisualDensity.standard,
            shape: WidgetStatePropertyAll(
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
            ),
            foregroundColor: WidgetStateProperty.resolveWith((states) {
              if (states.contains(WidgetState.disabled)) {
                return grid.AppPalette.textFaint;
              }
              if (states.contains(WidgetState.hovered) ||
                  states.contains(WidgetState.focused)) {
                return AppColors.text;
              }
              return AppColors.mutedStrong.withValues(alpha: .8);
            }),
            overlayColor: WidgetStatePropertyAll(grid.AppSurface.hoverFill),
          ),
        );
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        action('Reload viewer', LucideIcons.refreshCw, onReload),
        const SizedBox(width: 2),
        action(
          zoomed ? 'Restore agents' : 'Zoom viewer',
          zoomed ? LucideIcons.minimize : LucideIcons.maximize,
          onZoom,
        ),
        const SizedBox(width: 2),
        action('Close viewer', LucideIcons.x, onClose),
      ],
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({
    super.key,
    required this.icon,
    required this.title,
    required this.detail,
    this.action,
  });

  final IconData icon;
  final String title;
  final String detail;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 26, color: AppColors.mutedStrong),
          const SizedBox(height: 10),
          Text(
            title,
            style: TextStyle(
              color: AppColors.text,
              fontFamily: AppFonts.sans,
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            detail,
            textAlign: TextAlign.center,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: AppColors.mutedStrong,
              fontFamily: AppFonts.mono,
              fontFamilyFallback: AppFonts.monoFallback,
              fontSize: 11,
            ),
          ),
          if (action != null) ...[const SizedBox(height: 8), action!],
        ],
      ),
    ),
  );
}
