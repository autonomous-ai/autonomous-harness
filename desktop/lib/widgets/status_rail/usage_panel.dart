import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../usage/usage_accounts.dart';
import '../../usage/usage_pressure.dart';
import '../../usage/usage_window.dart';
import '../engine_identity.dart';
import 'usage_ink.dart';

/// What a panel calls this computer when neither the sidebar nor the OS has a
/// name for it.
const String _kThisComputer = 'This computer';

/// What one account has spent, window by window.
///
/// The panel behind a figure on the status rail: the same numbers the strip
/// prints, given the room to say which window each belongs to and when it
/// starts over.
class UsagePanelContent extends StatelessWidget {
  const UsagePanelContent({
    super.key,
    required this.accounts,
    this.machineName,
  });

  /// Every account of ONE provider, this computer's first
  /// (`groupUsageAccounts`). With a single account — the common case, and every
  /// case where the remote machines share this computer's subscription — the
  /// panel is exactly the one it always was: captions appear only once there is
  /// something to tell apart.
  final List<UsageAccount> accounts;

  /// What to call THIS computer — the sidebar's own name for it, from
  /// `AppNotifier.thisMachineName`.
  ///
  /// Replaces the words "This computer", which were right while that was the
  /// only machine a panel could be about and are a wasted line now: a reader
  /// with two machines signed in sees one caption naming a host and another
  /// naming none, and has to work out that the nameless one is the one they
  /// are sitting at. The name says it and matches the rail above it.
  ///
  /// Null falls back to those words rather than printing a blank caption.
  final String? machineName;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final captioned = accounts.length > 1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _Header(reading: accounts.first.reading),
        // Whose spend this is. The rail can carry other machines' accounts
        // as well as this one's, so a panel that named no scope would leave
        // the reader to infer it.
        //
        // Only when there is ONE account: past that the per-account captions
        // below already name every machine, and a heading claiming this
        // computer over a list including two others would be wrong.
        if (!captioned) ...[
          const SizedBox(height: 4),
          _PanelScope(name: machineName),
        ],
        for (final (index, account) in accounts.indexed) ...[
          if (captioned) ...[
            SizedBox(height: index == 0 ? 12 : 16),
            _AccountCaption(account: account, machineName: machineName),
          ],
          ..._accountBody(account.reading),
        ],
      ],
    );
  }

  /// One account's windows — or, when it has none, the sentence its source
  /// wrote about why, because the source is what knows whether signing in or
  /// retrying is the way out.
  static List<Widget> _accountBody(ProviderUsage reading) {
    if (!reading.hasFigures) {
      return [
        const SizedBox(height: 10),
        Text(
          reading.message ?? 'No usage to show',
          style: TextStyle(
            color: grid.AppPalette.textFaint,
            fontSize: 11.5,
            height: 1.35,
          ),
        ),
      ];
    }
    return [
      for (final window in reading.windows) ...[
        const SizedBox(height: 12),
        _WindowRow(
          window: window,
          color: engineIdentity(reading.provider.engineId).color,
        ),
      ],
    ];
  }
}

/// Whose subscription a block of windows is, once a provider has more than one.
class _AccountCaption extends StatelessWidget {
  const _AccountCaption({required this.account, this.machineName});

  final UsageAccount account;

  /// This computer's own name, for the local block — see
  /// [UsagePanelContent.machineName].
  final String? machineName;

  @override
  Widget build(BuildContext context) => Text(
    _caption,
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
    style: TextStyle(
      color: grid.AppPalette.textSecondary,
      fontSize: 11,
      fontWeight: grid.AppFont.medium,
    ),
  );

  String get _caption {
    if (!account.isLocal) return account.machines.join(', ');
    // The machine's own name, falling back to [_kThisComputer] when the rail
    // has none to give — a caption is worth more than a blank line.
    final own = machineName?.trim();
    final here = own == null || own.isEmpty ? _kThisComputer : own;
    return account.machines.isEmpty
        ? here
        : '$here · also ${account.machines.join(', ')}';
  }
}

/// Whose spend a single-account panel is showing: this computer, named.
class _PanelScope extends StatelessWidget {
  const _PanelScope({required this.name});

  final String? name;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final style = TextStyle(
      fontSize: 11,
      height: 1.35,
      color: grid.AppPalette.textSecondary,
    );
    final own = name?.trim();
    return RichText(
      // One line: a hostname can be long and this panel is 248px across.
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      text: TextSpan(
        style: style,
        children: [
          TextSpan(text: 'Computer · ', style: style),
          TextSpan(
            text: own == null || own.isEmpty ? _kThisComputer : own,
            style: style.copyWith(
              color: grid.AppPalette.textPrimary,
              fontWeight: grid.AppFont.medium,
            ),
          ),
        ],
      ),
    );
  }
}

/// The account this panel is about, and how fresh its figures are.
class _Header extends StatelessWidget {
  const _Header({required this.reading});

  final ProviderUsage reading;

  @override
  Widget build(BuildContext context) {
    final fetchedAt = reading.fetchedAt;
    return Row(
      children: [
        // The mark the machine rail already draws beside every agent of this
        // engine — the account's own logo, in its own colour. Drawing a second
        // glyph here would make one account look like two things.
        EngineMark(engine: reading.provider.engineId, size: 13),
        const SizedBox(width: 7),
        Text(
          reading.provider.label,
          style: TextStyle(
            color: grid.AppPalette.textPrimary,
            fontSize: 12.5,
            fontWeight: grid.AppFont.semibold,
          ),
        ),
        const Spacer(),
        if (fetchedAt != null)
          // Flexible, not bare: the account's name is the header's point and
          // must never be pushed out by the freshness note beside it, which is
          // the half that can afford to shorten.
          Flexible(
            child: Text(
              _freshness(fetchedAt),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.right,
              style: TextStyle(
                color: grid.AppPalette.textFaint,
                fontSize: 10.5,
              ),
            ),
          ),
      ],
    );
  }

  /// How long ago the figures were read, at the granularity the poll actually
  /// has. Anything finer would be a precision the once-a-minute refresh behind
  /// it cannot back up.
  static String _freshness(DateTime at) {
    final since = DateTime.now().difference(at);
    if (since.inMinutes < 1) return 'Updated just now';
    if (since.inMinutes < 60) return 'Updated ${since.inMinutes}m ago';
    return 'Updated ${since.inHours}h ago';
  }
}

/// One window: what it is, how full it is, and when it empties.
class _WindowRow extends StatelessWidget {
  const _WindowRow({required this.window, required this.color});

  final UsageWindow window;

  /// The account's own colour, so the bar and the mark at the top of the panel
  /// are visibly the same account's.
  final Color color;

  @override
  Widget build(BuildContext context) {
    final resetsIn = window.resetsInLabel();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          window.label,
          style: TextStyle(
            color: grid.AppPalette.textPrimary,
            fontSize: 11.5,
            fontWeight: grid.AppFont.medium,
          ),
        ),
        const SizedBox(height: 6),
        UsageBar(usedPercent: window.usedPercent, color: color),
        const SizedBox(height: 5),
        Row(
          children: [
            Text(
              '${window.usedPercent.round()}% used',
              style: TextStyle(
                color: grid.AppPalette.textSecondary,
                fontSize: 11,
              ),
            ),
            const Spacer(),
            // No reset time means no countdown — never "resets in 0m", which
            // would read as a measurement rather than as the silence it is.
            if (resetsIn != null)
              Text(
                'Resets in $resetsIn',
                style: TextStyle(
                  color: grid.AppPalette.textFaint,
                  fontSize: 11,
                ),
              ),
          ],
        ),
      ],
    );
  }
}

/// How full one window is.
///
/// Drawn 6px and fully rounded, in the **account's own colour** — the same
/// colour as the mark at the top of the panel. The first version was a 3px grey sliver on a recessed
/// track, and at the single-digit percentages these windows actually sit at for
/// most of their life it was invisible: the figure beside it was doing all the
/// work and the bar was decoration that could not be seen.
///
/// Turns amber past [kUsageWarnPercent] and red past [kUsageCriticalPercent].
/// The figure is already exact, so the colour is not carrying the number — it
/// is carrying the moment the number starts to matter, which a bar that never
/// changes hue cannot. Both thresholds come from `usage_pressure.dart`, shared
/// with the rail figure this panel expands: a bar that went amber at a
/// different number from the figure above it would make one window look like
/// two readings.
class UsageBar extends StatelessWidget {
  const UsageBar({
    super.key,
    required this.usedPercent,
    required this.color,
    this.height = 6,
  });

  final double usedPercent;

  /// The account's colour. Overridden once the window is nearly spent, because
  /// "which account" matters less at that point than "how close".
  final Color color;

  final double height;

  /// The narrowest the filled part may be drawn.
  ///
  /// Below this a band of colour reads as a rendering artefact rather than a
  /// quantity, so a small percentage is over-represented on purpose. A window at 2% is *not* a
  /// window at 0%, and the bar has to be able to say so — the exact figure is
  /// printed directly underneath, so nothing is lost by rounding up here.
  static const double _minFill = 4;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final fill = usagePressureInk(usagePressureOf(usedPercent), color);
    return ClipRRect(
      borderRadius: BorderRadius.circular(height / 2),
      child: SizedBox(
        height: height,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final full = constraints.maxWidth;
            final measured = full * (usedPercent / 100).clamp(0.0, 1.0);
            // Zero stays zero: an untouched window draws no colour at all, or
            // the bar would claim usage nobody has spent.
            final width = measured <= 0
                ? 0.0
                : measured.clamp(_minFill, full).toDouble();
            // BOTH children are positioned, deliberately. A Stack takes its
            // size from its non-positioned children, so an unpositioned fill
            // made the Stack as narrow as the fill itself — dragging the track
            // in with it — while the fill's own ColoredBox, left with loose
            // height, collapsed to nothing. The result drew the *track* at the
            // fill's width: the right length in the wrong colour, which is
            // exactly the bug this bar was rewritten to fix.
            return Stack(
              children: [
                Positioned.fill(
                  child: ColoredBox(color: grid.AppSurface.recess),
                ),
                Positioned(
                  // Keyed so a test can measure what was actually painted:
                  // this bar's whole failure mode is being present in the
                  // widget tree and invisible on screen.
                  key: const Key('usage-bar-fill'),
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: width,
                  child: ColoredBox(color: fill),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
