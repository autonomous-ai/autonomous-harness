import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../state/app_state.dart';
import '../../usage/usage_accounts.dart';
import '../../usage/usage_controller.dart';
import '../../usage/usage_window.dart';
import 'rail_figure.dart';
import 'rail_panel.dart';
import 'usage_panel.dart';
import 'usage_readout.dart';

/// The status rail's usage figures, each opening the panel that spells it out.
///
/// Owns only the hover-and-pin behaviour around [UsageReadout]: which figure
/// the pointer is on, whose panel is showing, and whether a click is holding
/// it open. The figures are the readout's, and the panel's content is
/// [UsagePanelContent]'s.
class UsageRail extends StatefulWidget {
  const UsageRail({super.key, required this.usage, required this.notifier});

  final UsageController usage;

  /// For what the sidebar calls this computer, which the panel names its own
  /// account by.
  final AppNotifier notifier;

  @override
  State<UsageRail> createState() => _UsageRailState();
}

class _UsageRailState extends State<UsageRail> {
  /// One anchor per provider, made up front rather than per build: an anchor
  /// rebuilt mid-hover would hand the open panel a [LayerLink] its target no
  /// longer holds, and the panel would jump to the window's origin.
  final Map<UsageProvider, RailFigureAnchor> _anchors = {
    for (final provider in UsageProvider.values)
      provider: newRailFigureAnchor(),
  };
  final _portal = OverlayPortalController();

  /// Ties the rail and its panel into one tap region, so a click inside either
  /// is not the "click outside" that dismisses a pinned panel.
  final _tapGroup = Object();

  /// What the pointer is over right now, or null when it is over none of it.
  ///
  /// Moving between two figures sets this to the new one *before* the old one's
  /// delayed close runs, which is what lets the panel swap in place instead of
  /// blinking shut and reopening. It is also what carries the pointer across
  /// the gap between a figure and the panel above it: the panel sets this to
  /// the provider it is showing, so leaving the figure finds it already
  /// claimed.
  UsageProvider? _hovered;

  /// Whose panel is showing, or null before any has opened.
  UsageProvider? _panel;

  /// Held open by a click, rather than by the pointer resting on the rail.
  ///
  /// Hover alone cannot hold a panel still for reading: the pointer wanders on
  /// its way to anything else, and a panel that closes the moment it does has
  /// to be summoned again to finish a line. A pinned panel closes on a second
  /// click, or on a click anywhere outside it.
  bool _pinned = false;

  /// What a click pins when the pointer is on no figure: the first account
  /// with figures to show.
  UsageProvider? get _firstWithFigures => widget.usage.accounts
      .where((account) => account.reading.hasFigures)
      .firstOrNull
      ?.provider;

  void _hide() {
    _pinned = false;
    if (_portal.isShowing) _portal.hide();
  }

  /// The pointer settled on [provider] — a figure, or the open panel itself.
  ///
  /// With a panel already open the swap is immediate: the pointer has crossed
  /// from one figure to the next inside a surface it never left, and re-serving
  /// the wait there would make the rail feel like it had to be re-asked. The
  /// wait is for *opening*, so a pointer crossing the rail on its way elsewhere
  /// does not flash a panel open behind it.
  void _onEnter(UsageProvider provider) {
    _hovered = provider;
    if (_portal.isShowing) {
      if (_panel != provider) setState(() => _panel = provider);
      return;
    }
    Future<void>.delayed(const Duration(milliseconds: 180), () {
      if (!mounted || _hovered != provider) return;
      setState(() => _panel = provider);
      _portal.show();
    });
  }

  /// The pointer left [provider]. Closes only if it has not landed on another
  /// figure or on the panel — the guard is the *current* hover, not this one,
  /// so figure-to-figure and figure-to-panel both survive the gap.
  void _onExit(UsageProvider provider) {
    if (_hovered == provider) _hovered = null;
    // A beat of grace so the pointer can cross the gap between the rail and the
    // panel without the panel closing out from under it.
    Future<void>.delayed(const Duration(milliseconds: 120), () {
      if (!mounted || _hovered != null || _pinned) return;
      _hide();
    });
  }

  /// A click pins whatever the pointer is on, so the panel can be read without
  /// the pointer having to stay put.
  void _toggle() {
    if (_pinned) {
      _hide();
      return;
    }
    final target = _hovered ?? _firstWithFigures;
    if (target == null) return;
    _pinned = true;
    setState(() => _panel = target);
    _portal.show();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.usage,
      builder: (context, _) => _figures(),
    );
  }

  Widget _figures() {
    final usage = widget.usage;
    // No account signed in here: the strip keeps its key hints and says
    // nothing else, rather than drawing a figure-shaped blank that will never
    // fill.
    if (!usage.loading && usage.answered.isEmpty) {
      return const SizedBox.shrink();
    }
    return TapRegion(
      groupId: _tapGroup,
      onTapOutside: (_) {
        if (_pinned) _hide();
      },
      child: OverlayPortal(
        controller: _portal,
        overlayChildBuilder: (context) {
          final provider = _panel;
          return provider == null
              ? const SizedBox.shrink()
              : _panelFor(provider);
        },
        child: GestureDetector(
          // Defer, not opaque: a click on the empty rail beside the figures
          // must not pin a panel.
          behavior: HitTestBehavior.deferToChild,
          onTap: _toggle,
          child: UsageReadout(
            accounts: usage.accounts,
            loading: usage.loading,
            anchorFor: (provider) => _anchors[provider]!,
            onEnter: _onEnter,
            onExit: _onExit,
          ),
        ),
      ),
    );
  }

  /// One provider's accounts, under the figure that summarises them.
  ///
  /// Narrow: every row is a label, a bar and two short figures, and extra width
  /// would go to the bar alone — the one thing here that carries no reading of
  /// its own.
  Widget _panelFor(UsageProvider provider) {
    final accounts = [
      for (final account in widget.usage.accounts)
        if (account.provider == provider) account,
    ];
    return RailPanel(
      anchor: _anchors[provider]!,
      tapGroupId: _tapGroup,
      onEnter: () => _onEnter(provider),
      onExit: () => _onExit(provider),
      width: 248,
      child: UsagePanelContent(
        // A pinned panel can outlive its account: the next poll may drop it
        // from the grouped list. This computer's own reading — a loading one,
        // if need be — stands in rather than an empty panel.
        accounts: accounts.isNotEmpty
            ? accounts
            : [UsageAccount(reading: _localReading(provider), isLocal: true)],
        machineName: widget.notifier.thisMachineName,
      ),
    );
  }

  ProviderUsage _localReading(UsageProvider provider) =>
      widget.usage.readings.firstWhere(
        (reading) => reading.provider == provider,
        orElse: () => ProviderUsage.loading(provider),
      );
}
