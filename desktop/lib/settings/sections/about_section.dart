import 'package:flutter/material.dart';

import '../../core/app_version.dart';
import '../../core/build_identity.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/skeleton.dart';
import '../../state/app_state.dart';
import '../../widgets/flash_firmware_dialog.dart';
import '../../widgets/update_notice.dart';

/// Settings ▸ About: which build this is, and the way to ask for a newer one.
///
/// One card, and nothing else. Every other pane in Settings is a column of
/// [SettingRow]s because every other pane is a list of things you *change*;
/// this one is a single thing you *read*, and stating it as a settings list
/// would be claiming a shape the content doesn't have. What it does share with
/// them is the block: the app's raised-surface recipe (fill, soft lift, no rim),
/// so the one object on this screen sits at the same height as a setting next
/// door — which is what the pane was missing when it was label-and-value text
/// floating on the window.
///
/// The check runs through [AppNotifier.checkForUpdates] and reports through
/// [showUpdateCheckDialog] — the same pair the "Check for Updates…" menu item
/// drives, so the menu and this button can't answer differently. The card's
/// pill is the quiet half of that: the dialog is the answer to a question you
/// asked, the pill is the state you can see without asking.
///
/// "Flash dial firmware…" opens the same [showFlashFirmwareDialog] the native
/// macOS "Flash Firmware…" menu item does. It is in the card on every platform
/// rather than only where it is strictly needed, because on Linux and Windows
/// there is no native app menu and this is the ONLY way to reach it — and a
/// control that appears on some machines and not others is the harder thing to
/// support.
class AboutSection extends StatefulWidget {
  const AboutSection({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<AboutSection> createState() => _AboutSectionState();
}

class _AboutSectionState extends State<AboutSection> {
  /// Held here rather than on [AppNotifier]: a check started from this button
  /// is this screen's business, and the notifier already carries the state that
  /// outlives it (the update found, the install running, the error).
  bool _checking = false;

  Future<void> _check() async {
    setState(() => _checking = true);
    try {
      final result = await widget.notifier.checkForUpdates();
      if (!mounted) return;
      await showUpdateCheckDialog(context, widget.notifier, result);
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return SectionScaffold(
      title: 'About',
      subtitle:
          '$desktopAppName attaches terminals to the agents running on your '
          'machines.',
      child: SingleChildScrollView(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: _AboutCard.maxWidth),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // The card is the only thing here that reads live state, so the
              // rebuild stops at it rather than taking the scaffold with it.
              ListenableBuilder(
                listenable: widget.notifier,
                builder: (context, _) => _AboutCard(
                  notifier: widget.notifier,
                  checking: _checking,
                  onCheck: _check,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                widget.notifier.desktopUpdatesEnabled
                    ? 'Harness checks for a newer build when it starts, and every '
                          'six hours after that.'
                    : 'Automatic and manual updates are disabled for this V2 preview.',
                style: TextStyle(
                  color: grid.AppPalette.textFaint,
                  fontSize: 11.5,
                  height: 1.45,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The app's calling card: what this is, which build, and how it's doing.
class _AboutCard extends StatelessWidget {
  const _AboutCard({
    required this.notifier,
    required this.checking,
    required this.onCheck,
  });

  final AppNotifier notifier;
  final bool checking;
  final Future<void> Function() onCheck;

  /// Wide enough for the sentence beside the button to hold two lines, narrow
  /// enough that the card still reads as an object on the pane rather than as
  /// the pane itself.
  static const double maxWidth = 520;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      decoration: BoxDecoration(
        // The same raised block `SettingRow` draws — fill plus a soft lift, no
        // rim — at the same 14. A different radius here would read as a card
        // borrowed from somewhere else.
        color: grid.AppGlass.surfaceFill,
        borderRadius: BorderRadius.circular(14),
        boxShadow: grid.AppGlass.cardShadow,
      ),
      padding: const EdgeInsets.fromLTRB(22, 22, 22, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Identity(state: _PillState.of(notifier, checking: checking)),
          const SizedBox(height: 18),
          Container(height: 1, color: grid.AppPalette.divider),
          const SizedBox(height: 14),
          if (notifier.desktopUpdatesEnabled) ...[
            _CheckRow(checking: checking, onCheck: onCheck),
            const SizedBox(height: 12),
          ],
          const _FlashRow(),
        ],
      ),
    );
  }
}

/// Icon, name, version, state — the four facts, on two lines.
class _Identity extends StatelessWidget {
  const _Identity({required this.state});

  final _PillState state;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        // The icon is already rounded with transparent corners, so it needs no
        // clip of its own — one would only cut its edge twice.
        Image.asset(
          'assets/app_icon.png',
          width: 46,
          height: 46,
          filterQuality: FilterQuality.medium,
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                desktopAppName,
                style: TextStyle(
                  color: grid.AppPalette.textPrimary,
                  fontSize: 16,
                  fontWeight: grid.AppFont.semibold,
                  letterSpacing: -0.1,
                ),
              ),
              const SizedBox(height: 4),
              _VersionLine(state: state),
            ],
          ),
        ),
      ],
    );
  }
}

/// "1.0.4  ·  Up to date" — the version read from the bundle rather than from
/// any file in this repo (`pubspec.yaml`'s version is a placeholder the release
/// never touches, see RELEASE.md), and beside it the one piece of state the
/// pane can answer without being asked.
class _VersionLine extends StatefulWidget {
  const _VersionLine({required this.state});

  final _PillState state;

  @override
  State<_VersionLine> createState() => _VersionLineState();
}

class _VersionLineState extends State<_VersionLine> {
  // Once per mount: the line rebuilds with every pill change, and a future
  // built in `build` would put the placeholder back for a frame each time.
  // `runningAppVersion`, not `PackageInfo` directly: `flutter build linux` has
  // nowhere to stamp a release version, so a packaged Linux build reads it from
  // the `version.txt` the release script writes instead.
  late final Future<String> _info = runningAppVersion();

  _PillState get state => widget.state;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final style = TextStyle(
      color: grid.AppPalette.textSecondary,
      fontSize: 12.5,
      fontFamily: grid.AppFont.mono,
      fontFamilyFallback: grid.AppFont.monoFallback,
    );
    return Row(
      children: [
        FutureBuilder<String>(
          future: _info,
          builder: (context, snapshot) {
            final version = snapshot.data;
            // A blank the width of a version while it is being read, not an
            // em dash: a dash is a value ("no version"), and this line is
            // about to have one. The dash is kept for the case it means —
            // the bundle answered and had nothing to say.
            if (version == null) {
              return snapshot.connectionState == ConnectionState.done
                  ? Text('—', style: style)
                  : SkeletonText(style: style, width: 44);
            }
            return Text(version, style: style);
          },
        ),
        const SizedBox(width: 9),
        _StatusPill(state: state),
      ],
    );
  }
}

/// The update state as a pill, resolved from the notifier the card is already
/// listening to.
///
/// Deliberately the *only* place the pane speaks about updates on its own: this
/// direction keeps the dialog, so anything with a decision in it — install,
/// skip, retry — stays there rather than growing a second set of buttons here
/// that the account menu's dialog would then have to agree with.
class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.state});

  final _PillState state;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 2, 9, 2),
      decoration: BoxDecoration(
        color: state.wash ? grid.AppSurface.accentWash : grid.AppCard.inset,
        borderRadius: BorderRadius.circular(999),
        border: state.wash
            ? null
            : Border.all(color: grid.AppPalette.divider, width: 1),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              color: state.color,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 6),
          Text(
            state.label,
            style: TextStyle(
              color: state.color,
              fontSize: 11,
              fontWeight: grid.AppFont.medium,
            ),
          ),
        ],
      ),
    );
  }
}

/// What the pill says, in priority order — the loudest true thing wins.
class _PillState {
  const _PillState(this.label, this.color, {this.wash = false});

  final String label;
  final Color color;

  /// Accent-washed rather than inset: reserved for the one state that is asking
  /// for something. A green "Up to date" tinted the same way would be shouting
  /// the good news.
  final bool wash;

  static _PillState of(AppNotifier notifier, {required bool checking}) {
    if (!notifier.desktopUpdatesEnabled) {
      return _PillState(
        'Preview · updates disabled',
        grid.AppPalette.textSecondary,
      );
    }
    if (notifier.isInstallingUpdate) {
      return _PillState(
        'Installing…',
        grid.AppPalette.accentOnSurface,
        wash: true,
      );
    }
    if (notifier.updateError != null) {
      return _PillState('Update failed', grid.AppPalette.warn);
    }
    final update = notifier.availableUpdate;
    if (update != null) {
      return _PillState(
        '${update.version} available',
        grid.AppPalette.accentOnSurface,
        wash: true,
      );
    }
    if (checking || notifier.isCheckingForUpdate) {
      return _PillState('Checking…', grid.AppPalette.textSecondary);
    }
    return _PillState('Up to date', grid.AppPalette.online);
  }
}

/// The sentence and the button that acts on it, on one line.
///
/// An [OutlinedButton], not a filled one. The design system spends its filled
/// button on the primary action of a screen, and the primary act on this screen
/// is reading it — a solid blue fill here made asking for an update the loudest
/// thing in the pane, over the name of the app it belongs to.
class _CheckRow extends StatelessWidget {
  const _CheckRow({required this.checking, required this.onCheck});

  final bool checking;
  final Future<void> Function() onCheck;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: Text(
            'It updates itself in the background — this is where you can ask '
            'early.',
            style: TextStyle(
              color: grid.AppPalette.textSecondary,
              fontSize: 12,
              height: 1.45,
            ),
          ),
        ),
        const SizedBox(width: 18),
        OutlinedButton(
          key: const Key('settings-check-updates-button'),
          onPressed: checking ? null : () => onCheck(),
          child: Text(checking ? 'Checking…' : 'Check for updates'),
        ),
      ],
    );
  }
}

/// The dial, in the same sentence-then-button shape the update row uses, so the
/// card reads as one object with two things you can ask of it.
class _FlashRow extends StatelessWidget {
  const _FlashRow();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: Text(
            'The hardware dial takes its firmware over USB.',
            style: TextStyle(
              color: grid.AppPalette.textSecondary,
              fontSize: 12,
              height: 1.45,
            ),
          ),
        ),
        const SizedBox(width: 18),
        OutlinedButton(
          key: const Key('settings-flash-firmware-button'),
          onPressed: () => showFlashFirmwareDialog(context),
          child: const Text('Flash dial firmware…'),
        ),
      ],
    );
  }
}
