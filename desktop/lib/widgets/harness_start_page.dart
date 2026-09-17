import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/harness_background.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import 'harness_entry_actions.dart';
import 'harness_customize_pane.dart';
import 'swarm_search_input.dart';
import 'swarm_switcher.dart';

/// The Open Agent input, results and navigation, revealed on the start page
/// only when the user chooses to search.
class HarnessStartPage extends StatefulWidget {
  const HarnessStartPage({
    super.key,
    required this.focusNode,
    required this.createSearch,
    required this.onNew,
    required this.onChoose,
    this.onStore,
  });
  final FocusNode focusNode;
  final SwarmSearchController Function() createSearch;
  final VoidCallback onNew;
  final ValueChanged<SwarmSearchSelection> onChoose;

  /// Open the Harness Store. Null hides its card (a build without one).
  final VoidCallback? onStore;
  @override
  State<HarnessStartPage> createState() => _HarnessStartPageState();
}

class _HarnessStartPageState extends State<HarnessStartPage> {
  final _query = TextEditingController();
  FocusNode get _focus => widget.focusNode;
  final _pickerFocus = FocusNode(
    debugLabel: 'Start page picker',
    canRequestFocus: false,
  );
  final _searchGroup = Object();
  final _customizeButtonFocus = FocusNode(debugLabel: 'Customize Harness');
  bool _customizing = false;
  SwarmSearchController? _search;
  SwarmSearchDraft? _draft;
  bool get _showResults => _search != null;

  void _customize() {
    _close();
    setState(() => _customizing = true);
  }

  void _closeCustomization() {
    setState(() => _customizing = false);
    _customizeButtonFocus.requestFocus();
  }

  void _open() {
    // Commands can replace the editor value without a TextField onChanged.
    // Reveal results for the visible text, including on keyboard-only entry.
    if (_search == null) {
      final search = widget.createSearch();
      if (_draft case final draft?) search.restoreDraft(draft);
      search.setQuery(_query.text);
      setState(() => _search = search);
    } else {
      _search!.setQuery(_query.text);
    }
    _focus.requestFocus();
  }

  void _close() {
    final search = _search;
    if (search != null) {
      _draft = search.draft;
      setState(() => _search = null);
      search.dispose();
    }
    _pickerFocus.unfocus();
  }

  void _choose(SwarmSearchSelection selection) {
    _close();
    widget.onChoose(selection);
  }

  void _new() {
    _close();
    widget.onNew();
  }

  Widget _searchPanel() => TextFieldTapRegion(
    groupId: _searchGroup,
    child: Focus(
      focusNode: _pickerFocus,
      child: Material(
        color: grid.AppPalette.swarmSearchSurface,
        surfaceTintColor: Colors.transparent,
        elevation: _showResults ? 10 : 2,
        shadowColor: Colors.black38,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(32),
          side: BorderSide(color: Colors.white.withValues(alpha: .10)),
        ),
        clipBehavior: Clip.antiAlias,
        child: SwarmSearchKeys(
          search: _search,
          editing: _query,
          onChoose: _choose,
          onClose: _close,
          onOpen: _open,
          onNewAgent: _new,
          onRefocus: _focus.requestFocus,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(
                label: 'Find a harness',
                child: SwarmSearchInput(
                  inputKey: const ValueKey('harness-start-search'),
                  controller: _query,
                  focusNode: _focus,
                  search: _search,
                  onClose: _close,
                  onChanged: (_) => _open(),
                  onOpen: _open,
                  onTapOutside: _close,
                  groupId: _searchGroup,
                  autofocus: true,
                  showClose: _showResults,
                  hintText: 'Find a harness',
                  rounded: true,
                  prominent: true,
                ),
              ),
              if (_showResults) ...[
                Flexible(
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: SizedBox(
                      height: 480,
                      child: SwarmSearchResults(
                        key: const ValueKey('harness-start-results'),
                        search: _search!,
                        sideBySideMinWidth: 700,
                        onChoose: _choose,
                        onRefocus: _focus.requestFocus,
                      ),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    ),
  );

  /// The door to the Harness Store, in the device card's own shape: a shelf of
  /// the harness marks, and the words. Same size, same corner, so the two read
  /// as a pair of things you can get.
  Widget _store({required bool compact}) {
    return Semantics(
      button: true,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: compact ? 300 : 360),
        child: AspectRatio(
          aspectRatio: 2,
          child: Material(
            color: const Color(0xFF101112),
            borderRadius: BorderRadius.circular(16),
            clipBehavior: Clip.antiAlias,
            child: Stack(
              fit: StackFit.expand,
              children: [
                Image.asset(
                  'assets/harness_store_card.png',
                  fit: BoxFit.cover,
                  excludeFromSemantics: true,
                ),
                Material(
                  color: Colors.transparent,
                  child: InkWell(
                    key: const ValueKey('harness-store-link'),
                    mouseCursor: SystemMouseCursors.click,
                    onTap: widget.onStore,
                    hoverColor: Colors.white.withValues(alpha: .04),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: FractionallySizedBox(
                        widthFactor: .48,
                        child: Padding(
                          padding: const EdgeInsets.only(left: 18, right: 8),
                          child: Text(
                            'Browse the\nHarness Store',
                            style: TextStyle(
                              fontSize: 16,
                              height: 1.3,
                              fontWeight: FontWeight.w500,
                              color: Colors.white.withValues(alpha: .94),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// A compact product photograph below the agent controls.
  Widget _device({required bool compact}) {
    return Semantics(
      link: true,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: compact ? 300 : 360),
        child: AspectRatio(
          aspectRatio: 2,
          child: Material(
            color: const Color(0xFF101112),
            borderRadius: BorderRadius.circular(16),
            clipBehavior: Clip.antiAlias,
            child: Stack(
              fit: StackFit.expand,
              children: [
                Image.asset(
                  'assets/harness_device_studio.png',
                  fit: BoxFit.cover,
                  excludeFromSemantics: true,
                ),
                Material(
                  color: Colors.transparent,
                  child: InkWell(
                    key: const ValueKey('harness-device-link'),
                    mouseCursor: SystemMouseCursors.click,
                    onTap: _openDevicePage,
                    hoverColor: Colors.white.withValues(alpha: .04),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: FractionallySizedBox(
                        widthFactor: .48,
                        child: Padding(
                          padding: const EdgeInsets.only(left: 18, right: 8),
                          child: Text(
                            'Meet the\nHarness device',
                            style: TextStyle(
                              fontSize: 16,
                              height: 1.3,
                              fontWeight: FontWeight.w500,
                              color: Colors.white.withValues(alpha: .94),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _openDevicePage() => launchUrl(
    Uri.parse('https://www.autonomous.ai/harness-device'),
    mode: LaunchMode.externalApplication,
  );

  @override
  void dispose() {
    _search?.dispose();
    _query.dispose();
    _pickerFocus.dispose();
    _customizeButtonFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final paneWidth = constraints.maxWidth.clamp(0.0, 420.0);
        final sideBySide = constraints.maxWidth >= 1000;
        return Row(
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  _page(),
                  Positioned(
                    right: 20,
                    bottom: 16,
                    child: ValueListenableBuilder<AppearancePrefs>(
                      valueListenable: appearancePrefsStore,
                      builder: (context, prefs, _) {
                        final onPressed = _customizing
                            ? _closeCustomization
                            : _customize;
                        if (prefs.background != HarnessBackground.plain) {
                          return IconButton.filled(
                            key: const ValueKey('harness-customize-button'),
                            focusNode: _customizeButtonFocus,
                            onPressed: onPressed,
                            tooltip: 'Customize Harness',
                            icon: const Icon(Icons.edit_outlined, size: 18),
                            style: IconButton.styleFrom(
                              backgroundColor: grid.AppPalette.swarmAccent,
                              foregroundColor: grid.AppPalette.swarmTabBar,
                              fixedSize: const Size.square(40),
                              shape: const CircleBorder(),
                            ),
                          );
                        }
                        return FilledButton.icon(
                          key: const ValueKey('harness-customize-button'),
                          focusNode: _customizeButtonFocus,
                          onPressed: onPressed,
                          icon: const Icon(Icons.edit_outlined, size: 16),
                          label: const Text('Customize Harness'),
                          style: FilledButton.styleFrom(
                            backgroundColor: grid.AppPalette.swarmAccent,
                            foregroundColor: grid.AppPalette.swarmTabBar,
                            minimumSize: const Size(0, 36),
                            shape: const StadiumBorder(),
                          ),
                        );
                      },
                    ),
                  ),
                  if (_customizing && !sideBySide)
                    Positioned(
                      top: 0,
                      bottom: 0,
                      right: 0,
                      width: paneWidth,
                      child: HarnessCustomizePane(onClose: _closeCustomization),
                    ),
                ],
              ),
            ),
            if (_customizing && sideBySide)
              SizedBox(
                width: paneWidth,
                child: HarnessCustomizePane(onClose: _closeCustomization),
              ),
          ],
        );
      },
    );
  }

  Widget _page() {
    return LayoutBuilder(
      builder: (context, constraints) {
        return Padding(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 80),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1120),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, entryConstraints) {
                        // Reserve the footer before laying out search, keeping
                        // both its top edge and the device still as results open.
                        final top = (constraints.maxHeight * 0.21)
                            .clamp(72.0, 220.0)
                            .clamp(
                              0.0,
                              (entryConstraints.maxHeight - 320).clamp(
                                24.0,
                                220.0,
                              ),
                            );
                        return Padding(
                          padding: EdgeInsets.only(top: top),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Flexible(child: _searchPanel()),
                              if (!_showResults) ...[
                                const SizedBox(height: 20),
                                HarnessEntryActions(
                                  onOpen: _open,
                                  onNew: _new,
                                  openKey: const ValueKey('harness-start-open'),
                                  newKey: const ValueKey('harness-start-new'),
                                ),
                              ],
                            ],
                          ),
                        );
                      },
                    ),
                  ),
                  const SizedBox(height: 24),
                  // One row, always: the two cards shrink together rather than
                  // wrapping, because a second row grows the footer the search
                  // above has reserved and pushes the page past its bottom edge.
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      if (widget.onStore != null) ...[
                        Flexible(
                          child: _store(compact: constraints.maxHeight < 600),
                        ),
                        const SizedBox(width: 16),
                      ],
                      Flexible(
                        child: _device(compact: constraints.maxHeight < 600),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
