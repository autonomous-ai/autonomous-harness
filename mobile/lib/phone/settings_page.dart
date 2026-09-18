import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'package:harness_mobile/core/app_version.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/appearance_prefs_store.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';
import 'package:harness_mobile/terminal/terminal_theme_store.dart';

import 'phone_header.dart';
import 'phone_sheet.dart';
import 'settings_row.dart';
import 'stats_entry.dart';
import 'usage_entry.dart';
import 'voice_language.dart';
import 'voice_language_store.dart';

/// The phone's Settings tab.
///
/// DELIBERATELY not the desktop's eight sections. Three of them cannot work in a viewer build and
/// would each be a screen that opens on nothing:
///
///  - **Autonomous devices** flashes an ESP32 over a serial port, through the CLI. A viewer has no
///    CLI and a phone has no serial port.
///  - **Keyboard shortcuts** is a list of ⌘ combinations for a keyboard that is not there.
///  - **Check for updates** belongs to the desktop updater; a phone build is updated by its store.
///
/// **Usage** used to be on that list, for a reason that was true of the desktop reader and not of
/// the setting: it counts by reading `~/.claude/projects`, `~/.codex` and OpenCode's SQLite file ON
/// THIS DISK, and a phone has none of them. What a phone can do is ask the machine that does — so
/// the section is kept, and its two rows come from elsewhere: `usage_entry.dart` reads each linked
/// machine's rate limits over `usage_read`, and `stats_entry.dart` reads the counters this app keeps
/// about itself.
///
/// What a phone shows that the desktop splits across panes:
///
///  - **Appearance** carries the six [HarnessPalette] choices the desktop keeps in its own
///    Customize pane. They are not decoration here: the phone's tab bar, cards and terminal ground
///    are all drawn from the chosen palette, and until now the phone shipped whichever one the
///    desktop had last written to `~/.harness`.
///  - **Terminal** carries the colour scheme beside the face and the size, because on a phone all
///    three answer the same question — what the pane looks like at arm's length.
///
/// The desktop's **Debug** screen has no counterpart here on purpose. It reads an in-memory ring
/// that only a debug build fills, so on a shipped phone the row would open on an empty page — and
/// the log files it mirrors are written either way, which is what a fault report actually needs.
///
/// What a phone adds instead is the account and the machine links, which the desktop keeps in its
/// rail footer — on a phone there is no rail, so this is the only way to reach either.

/// Whether the Terminal section offers the voice language.
///
/// Off: the mic transcribes in whatever [voiceLanguageStore] already holds, and there is no longer
/// anywhere in the app to change it by hand.
///
/// ⚠️ **That is the whole of the setting, so turning this back on is the only way back to it.**
/// The mic's long-press used to open the same picker, and hold-to-talk took that gesture for
/// recording (see `voice_mic_mode.dart`) — so with this off, the stored language is whatever it was
/// last set to, or the default for a phone that never set one. [_VoiceLanguageRow] and
/// [showVoiceLanguagePicker] are both still here and still work; nothing but this flag was changed.
const bool _showVoiceLanguage = false;

class SettingsPage extends StatelessWidget {
  const SettingsPage({super.key, required this.notifier, this.large = true});

  final AppNotifier notifier;

  /// The tab's big title. Off when the page is pushed from a terminal's menu, where it needs the
  /// back chevron a large header does not draw.
  final bool large;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) {
      AppTheme.watch(context);
      return Scaffold(
        backgroundColor: AppPalette.windowBg,
        body: SafeArea(
          bottom: false,
          child: Column(
            children: [
              PhoneHeader(large: large, title: 'Settings'),
              Expanded(child: _Body(notifier: notifier)),
            ],
          ),
        ),
      );
    },
  );
}

class _Body extends StatelessWidget {
  const _Body({required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) => ListView(
    padding: EdgeInsets.fromLTRB(
      16,
      // Zero: the first caption brings its own 22pt top, and any padding here would stack on it —
      // the gap under the big "Settings" title would then be a header gap plus a between-groups
      // gap, wider than every other gap on the screen.
      0,
      16,
      MediaQuery.paddingOf(context).bottom + 24,
    ),
    children: [
      const SettingsCaption('Account'),
      SettingsGroup(
        children: [
          SettingsRow(
            leading: _Avatar(notifier: notifier),
            title: notifier.currentUser?.displayName ?? 'Signed in',
            detail: notifier.currentUser?.email,
            onTap: () => _showAccountSheet(context, notifier),
          ),
        ],
      ),
      // ⚠️ Usage sits SECOND, right under the account and above the appearance settings, and that
      // is deliberate: it is the only run here anybody opens twice. Everything below it is set once
      // and left alone, so burying a figure people check daily under four preferences would be
      // ordering the list by how permanent each row is rather than by how often it is read.
      const SettingsCaption('Usage'),
      SettingsGroup(
        children: [
          buildUsageSettingsRow(context, notifier),
          buildStatsSettingsRow(context, notifier),
        ],
      ),
      const SettingsCaption('Terminal'),
      SettingsGroup(
        children: [
          // ⚠️ Voice language is hidden, not removed — flip [_showVoiceLanguage]
          // to bring the row back. [_VoiceLanguageRow] and the picker behind it
          // are untouched and still work; this is the only thing that was
          // drawing them.
          if (_showVoiceLanguage) _VoiceLanguageRow(),
          _FontRow(),
          _SizeRow(),
          _TerminalThemeRow(),
        ],
      ),
      const SettingsCaption('Appearance'),
      SettingsGroup(children: [_PaletteRow(), _TextSizeRow()]),
      const SettingsNote(
        'OpenHarness is dark-only, so a palette picks the shade rather than the mode.',
      ),
      const SettingsCaption('About'),
      SettingsGroup(children: const [_VersionRow(), _BuildRow()]),
    ],
  );

  void _showAccountSheet(BuildContext context, AppNotifier notifier) {
    showPhoneSheet(
      context,
      title: notifier.currentUser?.email ?? 'Signed in',
      actions: [
        PhoneSheetAction(
          icon: LucideIcons.logOut300,
          label: 'Sign out',
          destructive: true,
          onTap: () => unawaited(notifier.logout()),
        ),
      ],
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final user = notifier.currentUser;
    final source = (user?.name?.trim().isNotEmpty ?? false)
        ? user!.name!.trim()
        : (user?.email ?? '');
    final initial = source.isEmpty ? '?' : source.substring(0, 1).toUpperCase();
    return Container(
      // 34, matching the stepper beside it two rows down: both are the tallest thing in their row,
      // and at 38 this one alone pushed its row past [kSettingsRowHeight] while the others sat on
      // it — one card with a taller first row.
      width: 34,
      height: 34,
      decoration: BoxDecoration(
        color: AppPalette.avatarFill,
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: Text(
        initial,
        style: const TextStyle(
          color: Colors.white,
          // Scaled with the disc: 15pt inside 34 left almost no ring around the letter, which
          // reads as a cramped badge rather than an avatar.
          fontSize: 14,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// The language the mic under every terminal transcribes in. A long press on the mic opens the
/// same picker.
class _VoiceLanguageRow extends StatelessWidget {
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
    valueListenable: voiceLanguageStore,
    builder: (context, code, _) {
      AppTheme.watch(context);
      return SettingsRow(
        title: 'Voice language',
        value: voiceLanguageName(code),
        onTap: () => unawaited(showVoiceLanguagePicker(context)),
      );
    },
  );
}

/// The terminal typeface. A sheet rather than a dropdown: a phone has room for the whole list.
class _FontRow extends StatelessWidget {
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
    valueListenable: terminalFontStore,
    builder: (context, _, _) {
      AppTheme.watch(context);
      return SettingsRow(
        title: 'Font',
        value: terminalFontStore.family.label,
        onTap: () => showPhoneSheet(
          context,
          title: 'Terminal font',
          actions: [
            for (final choice in TerminalFontChoice.available)
              PhoneSheetAction(
                icon: choice == terminalFontStore.family
                    ? LucideIcons.check300
                    : LucideIcons.type300,
                label: choice.label,
                onTap: () => unawaited(terminalFontStore.setFamily(choice)),
              ),
          ],
        ),
      );
    },
  );
}

/// Terminal text size, as a stepper rather than buried a screen deeper: on a phone this is the
/// setting people actually reach for, because the same pane that reads fine indoors is unreadable
/// at arm's length on a train.
class _SizeRow extends StatelessWidget {
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
    valueListenable: terminalFontStore,
    builder: (context, _, _) {
      AppTheme.watch(context);
      final size = terminalFontStore.size;
      return SettingsRow(
        title: 'Size',
        trailing: SettingsStepper(
          value: size.toStringAsFixed(0),
          // The bounds are the store's own, so a lit + that does nothing is impossible.
          onDecrease: size > TerminalFontStore.minSize
              ? () => unawaited(terminalFontStore.decreaseSize())
              : null,
          onIncrease: size < TerminalFontStore.maxSize
              ? () => unawaited(terminalFontStore.increaseSize())
              : null,
        ),
      );
    },
  );
}

/// The terminal's colour scheme. Beside the face and the size rather than under Appearance, because
/// all three describe the pane a remote program draws into — and [TerminalThemeChoice.matchApp],
/// the default, is precisely the choice to follow Appearance instead.
class _TerminalThemeRow extends StatelessWidget {
  @override
  Widget build(BuildContext context) =>
      ValueListenableBuilder<TerminalThemeChoice>(
        valueListenable: terminalThemeStore,
        builder: (context, choice, _) {
          AppTheme.watch(context);
          return SettingsRow(
            title: 'Colors',
            value: choice.label,
            onTap: () => showPhoneSheet(
              context,
              title: 'Terminal colors',
              actions: [
                for (final option in TerminalThemeChoice.values)
                  PhoneSheetAction(
                    icon: option == choice
                        ? LucideIcons.check300
                        : LucideIcons.palette300,
                    label: option.label,
                    onTap: () => unawaited(terminalThemeStore.set(option)),
                  ),
              ],
            ),
          );
        },
      );
}

/// The app's palette — the six [HarnessPalette] choices the desktop lays out as swatch cards.
///
/// A sheet of names rather than a grid of previews, and the difference is the screen: the desktop's
/// cards each draw a miniature workspace, which needs the width of a settings pane to be legible at
/// all. Shrunk to a phone's column they would be six indistinguishable dark rectangles. The app
/// repaints on the tap anyway — [AppearancePrefsStore.setPalette] moves the notifier before it
/// writes — so the preview IS the app behind the sheet, at full size, which no swatch can beat.
class _PaletteRow extends StatelessWidget {
  @override
  Widget build(BuildContext context) => ValueListenableBuilder<AppearancePrefs>(
    valueListenable: appearancePrefsStore,
    builder: (context, prefs, _) {
      AppTheme.watch(context);
      return SettingsRow(
        title: 'Palette',
        value: prefs.palette.label,
        onTap: () => showPhoneSheet(
          context,
          title: 'Color palette',
          actions: [
            for (final palette in HarnessPalette.values)
              PhoneSheetAction(
                icon: palette == prefs.palette
                    ? LucideIcons.check300
                    : LucideIcons.swatchBook300,
                label: '${palette.label} · ${palette.description}',
                onTap: () =>
                    unawaited(appearancePrefsStore.setPalette(palette)),
              ),
          ],
        ),
      );
    },
  );
}

/// The app's own text size — everything that is not the terminal.
class _TextSizeRow extends StatelessWidget {
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
    valueListenable: appearancePrefsStore,
    builder: (context, prefs, _) {
      AppTheme.watch(context);
      final size = prefs.uiSize;
      return SettingsRow(
        title: 'Text size',
        trailing: SettingsStepper(
          value: size.toStringAsFixed(0),
          onDecrease: size > AppearancePrefs.uiSizeMin
              ? () => unawaited(appearancePrefsStore.setUiSize(size - 1))
              : null,
          onIncrease: size < AppearancePrefs.uiSizeMax
              ? () => unawaited(appearancePrefsStore.setUiSize(size + 1))
              : null,
        ),
      );
    },
  );
}

/// The version, read from the bundle rather than from `pubspec.yaml` — see [appVersion].
class _VersionRow extends StatelessWidget {
  const _VersionRow();

  @override
  Widget build(BuildContext context) => FutureBuilder<String>(
    future: runningAppVersion(),
    builder: (context, snapshot) {
      AppTheme.watch(context);
      return SettingsRow(title: 'Version', value: snapshot.data ?? '—');
    },
  );
}

/// The build behind the version — `buildNumber` from the bundle, and the store's own identifier.
///
/// Version alone is not enough to name a phone build. Two TestFlight builds and two Play internal
/// tracks share one marketing version by design, and a bug report that says "1.0.0" names four
/// binaries. The build number is what the store shows beside a submission and what a crash report
/// is filed against, so it is the one figure support actually asks for — which is why it earns a
/// row rather than being folded into the version's text and lost to its own ellipsis.
///
/// ⚠️ Read through [PackageInfo] rather than [runningAppVersion]: that one deliberately answers only
/// the marketing version, with a Linux `version.txt` branch this platform never takes.
class _BuildRow extends StatelessWidget {
  const _BuildRow();

  /// Resolved ONCE per process, not per build of this row.
  ///
  /// [PackageInfo.fromPlatform] is a platform-channel round trip, and the settings list rebuilds on
  /// every [AppNotifier] notification — a socket frame, an agent's state change. A future created
  /// inline would fire one channel call per frame and flash the em dash back in each time while it
  /// resolved. The answer cannot change while the process lives, so caching it is exact rather than
  /// merely cheap.
  static final Future<PackageInfo> _info = PackageInfo.fromPlatform();

  @override
  Widget build(BuildContext context) => FutureBuilder<PackageInfo>(
    future: _info,
    builder: (context, snapshot) {
      AppTheme.watch(context);
      final info = snapshot.data;
      // Empty rather than missing on Linux/desktop dev builds, where nothing stamps it — the em
      // dash covers both, so a blank string never renders as a row with no value.
      final build = info?.buildNumber ?? '';
      return SettingsRow(
        title: 'Build',
        value: build.isEmpty ? '—' : build,
        detail: info?.packageName,
      );
    },
  );
}
