import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/login_relay_diagram.dart';

/// The sign-in screen.
///
/// This is the first thing a new install shows, and it is the only moment the
/// user is asking themselves *what am I handing this thing?* — so it answers
/// that, with the app's actual architecture, before asking for anything. The
/// diagram is [LoginRelayDiagram]: your machines at one end, the window at the
/// other, and a middle drawn wearing a blindfold because it genuinely cannot
/// read what crosses it.
///
/// **All four states live here**, in one card, rather than the two screens this
/// used to be. Pressing Sign in swapped the whole window for
/// `AwaitingBrowserLoginScreen`, at a different type scale — a hard cut in the
/// middle of a flow, and the reason the button's own spinner was almost never
/// seen. The wait is now a state of the button, so the frame never jumps.
///
/// ⚠️ **The SSO page cannot be embedded, and that is not a preference.**
/// `auth.autonomous.ai`'s Google sign-in uses Google's popup-based Identity
/// Services flow — a real popup window that posts its result back to its
/// opener — which a single-window embedded webview cannot satisfy. The system
/// browser handles it natively, so `AppNotifier.login` launches it there and
/// this screen tracks the wait, returning on its own once
/// `harness login --force --json` reports success. (This note came from the screen
/// that used to own the waiting state; it is the reason the flow leaves the
/// app at all, so it outlives the widget it was written on.)
class LoginScreen extends StatelessWidget {
  final AppNotifier notifier;
  const LoginScreen({super.key, required this.notifier});

  /// Matches `EnvironmentSetupScreen` (560) and `LinkMachineScreen` (460) —
  /// wide enough for the diagram to breathe, still centred at the 880×560
  /// minimum window.
  static const double _cardWidth = 520;

  @override
  Widget build(BuildContext context) {
    // Law 4: a widget that reads a colour token watches, or it freezes on the
    // boot palette when the theme flips. This screen used to call it zero times.
    grid.AppTheme.watch(context);

    // The same flag `RootShell` routes on, so the button's state and the reason
    // this screen is on screen at all can never disagree.
    final waiting = notifier.signingIn;

    return Scaffold(
      // The PANEL tone, not the window's. In light both `windowBg` and the
      // card's `surfaceFill` are pure white, so a card on the window is a card
      // you cannot see — only its shadow separates it, and at this size that
      // reads as a printing artefact rather than as a raised block. The rail's
      // own barely-there grey gives the card something to sit on in both
      // themes, which is the same trick the app plays everywhere else.
      backgroundColor: grid.AppPalette.panelBg,
      body: Stack(
        children: [
          const Positioned.fill(child: LoginAurora()),
          Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: _cardWidth),
                child: Container(
                  // The app's raised-block recipe: fill plus a soft lift, no rim.
                  decoration: BoxDecoration(
                    color: grid.AppGlass.surfaceFill,
                    borderRadius: BorderRadius.circular(14),
                    boxShadow: grid.AppCard.shadow,
                  ),
                  padding: const EdgeInsets.all(32),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const _AppMark(),
                      const SizedBox(height: 16),
                      const LoginRelayDiagram(),
                      const SizedBox(height: 24),
                      Text(
                        'All your agents, on one screen',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Your agents keep running on your own machines. '
                        'Harness gives you one window onto all of them.',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      const SizedBox(height: 24),
                      _Action(notifier: notifier, waiting: waiting),
                      if (notifier.lastError != null) ...[
                        const SizedBox(height: 16),
                        _ErrorTile(
                          message: notifier.lastError!,
                          onRetry: notifier.login,
                        ),
                      ],
                      const SizedBox(height: 24),
                      const _Seal(),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The button, and what it becomes while the browser is open.
///
/// One widget for both because they are one control in two states: the label
/// changes, a spinner replaces the glyph, and Cancel appears beside it. Nothing
/// moves position, so the wait reads as *this button is working* rather than as
/// a new screen.
class _Action extends StatelessWidget {
  const _Action({required this.notifier, required this.waiting});

  final AppNotifier notifier;
  final bool waiting;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);

    if (!waiting) {
      return Column(
        children: [
          FilledButton.icon(
            onPressed: notifier.login,
            icon: const Icon(Icons.login, size: grid.AppControl.iconSize),
            label: const Text('Sign in'),
          ),
          const SizedBox(height: 12),
          Text(
            'Your browser opens for SSO, then this window continues.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      );
    }

    return Column(
      children: [
        FilledButton.icon(
          // Disabled, not hidden: the control the user just pressed has to stay
          // where they left it, saying what it is doing.
          onPressed: null,
          icon: const SizedBox(
            width: grid.AppControl.iconSize,
            height: grid.AppControl.iconSize,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          label: const Text('Waiting for your browser'),
        ),
        const SizedBox(height: 12),
        Text(
          // Says the thing the idle line could not: what to do if the browser
          // did not come forward. That is the actual failure people hit here —
          // the tab opens behind the app and the window looks stuck.
          'Finish in your browser. If it didn\'t open, check behind this '
          'window.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: notifier.cancelLogin,
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}

/// A failure the user can act on.
///
/// The old screen printed the raw error in `Colors.red` with no container and
/// no way forward. Two things changed: the colour is a token that resolves per
/// theme, and there is a retry — the house rule is that every empty, loading
/// and error state offers a way on.
class _ErrorTile extends StatelessWidget {
  const _ErrorTile({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // Error INK on a surface, not `dangerFill`, which is tuned to carry white
    // lettering on top of it and is far too dark to read *as* text.
    final danger = grid.AppTheme.pick(
      const Color(0xFFB3261E),
      const Color(0xFFF2544B),
    );

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: grid.AppCard.inset,
        // Radius 8 inside a 14 card — a child is never rounder than its parent.
        borderRadius: BorderRadius.circular(grid.AppCard.insetRadius),
      ),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.error_outline, size: 16, color: danger),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Could not sign in',
                  style: Theme.of(context).textTheme.labelMedium
                      ?.copyWith(color: danger),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          SelectableText(message, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton(
              onPressed: onRetry,
              child: const Text('Try again'),
            ),
          ),
        ],
      ),
    );
  }
}

/// The quiet line at the foot of the card.
///
/// It says the guarantee in words anyone has — the cipher names that used to
/// sit here (`Ed25519 · ChaCha20-Poly1305`) were true, and unreadable to almost
/// everyone who saw them; they belong on a security page, not on the one screen
/// standing between someone and their work.
class _Seal extends StatelessWidget {
  const _Seal();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Column(
      children: [
        Divider(height: 1, color: grid.AppPalette.divider),
        const SizedBox(height: 16),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.lock_outline, size: 13, color: grid.AppPalette.teal),
            const SizedBox(width: 8),
            Text(
              'End-to-end encrypted',
              style: Theme.of(context).textTheme.labelSmall
                  ?.copyWith(color: grid.AppPalette.textFaint),
            ),
          ],
        ),
      ],
    );
  }
}

/// The app icon, on a recess that gives it somewhere to stand.
///
/// The asset is the Dock icon: an amber mark on its own charcoal tile. At 40px
/// on this card that tile composites into the card behind it — they are within
/// a few points of the same grey — so the tile disappears and what is left is a
/// bare amber shape floating in the middle of an indigo-and-teal screen. It
/// read as a warning badge rather than as a logo, and it took the eye before
/// the headline did.
///
/// The fix is not to recolour the brand. It is to give the mark the ground it
/// was drawn to sit on: [grid.AppCard.inset] is a step *darker* than the card
/// in dark and a step warmer-grey in light, so the tile has an edge again in
/// both themes. The amber then reads as deliberate — the one warm thing on the
/// screen, contained — instead of as a sticker someone left on.
class _AppMark extends StatelessWidget {
  const _AppMark();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      width: 56,
      height: 56,
      decoration: BoxDecoration(
        color: grid.AppCard.inset,
        // Radius 12 inside the card's 14 — a child is never rounder than its
        // parent, and the asset's own corners are rounder still inside this.
        borderRadius: BorderRadius.circular(12),
      ),
      alignment: Alignment.center,
      // No ClipRRect: the asset carries its own rounded corners, and clipping
      // would cut the edge twice. Same reason About renders it bare.
      child: Image.asset(
        'assets/app_icon.png',
        width: 36,
        height: 36,
        filterQuality: FilterQuality.medium,
      ),
    );
  }
}
