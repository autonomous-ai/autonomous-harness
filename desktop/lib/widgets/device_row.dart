import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../state/dial_status.dart';

/// Where to get one. The product page, and the same page the app's own Quick Setup card points at.
const String kDeviceStoreUrl = 'https://www.autonomous.ai/harness';

/// The dial's row on the rail's floor, above the account.
///
/// One row, never absent, saying one of three things — because the row is the SAME thing to three
/// different people. Someone who has never owned a dial is shown the way to get one; someone whose dial
/// is on the desk gets a way to its status; someone whose dial is in a drawer is told it is unplugged,
/// and is not sold a second one every time they glance at the rail. The three are told apart by two
/// facts the daemon and a remembered bit already carry ([DialState]), so nothing here guesses.
///
/// Drawn in the account pill's own idiom — same fill, radius and padding — so the floor reads as one
/// piece. Settings are NOT here: they live on the device (its last screen), and a second copy in the
/// window would be two places for one fact.
class DeviceRow extends StatefulWidget {
  const DeviceRow({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<DeviceRow> createState() => _DeviceRowState();
}

class _DeviceRowState extends State<DeviceRow> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.notifier.dial,
      builder: (context, _) {
        final dial = widget.notifier.dial;
        final status = dial.status;
        // What the row offers is decided by what the person HAS, not by what they might buy.
        final invite = !status.attached && !dial.seen;
        return Padding(
          padding: const EdgeInsets.fromLTRB(10, 0, 10, 4),
          child: MouseRegion(
            onEnter: (_) => setState(() => _hovered = true),
            onExit: (_) => setState(() => _hovered = false),
            cursor: SystemMouseCursors.click,
            child: GestureDetector(
              key: const Key('device-row'),
              behavior: HitTestBehavior.opaque,
              onTap: () => invite
                  ? unawaited(
                      launchUrl(
                        Uri.parse(kDeviceStoreUrl),
                        mode: LaunchMode.externalApplication,
                      ),
                    )
                  : unawaited(_showStatus(context)),
              child: AnimatedContainer(
                duration: grid.AppMotion.hover,
                curve: grid.AppMotion.curve,
                // The account pill's own metrics, so the two rows share a left column: a 32px
                // leading box — the avatar's real size, measured in _Avatar, not the 26 the pill
                // looks like — and a 10px gap put this row's mark and text exactly under the avatar
                // and the email. Off by six the first time, from reading the size off a screenshot.
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: _hovered
                      ? grid.AppSurface.recessHover
                      : grid.AppSurface.recess,
                  borderRadius: BorderRadius.circular(11),
                ),
                child: Row(
                  children: [
                    _Dot(live: status.attached),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'DEVICE',
                            style: TextStyle(
                              color: grid.AppPalette.textFaint,
                              fontFamily: grid.AppFont.sans,
                              fontFamilyFallback: grid.AppFont.sansFallback,
                              fontSize: 9.5,
                              fontWeight: grid.AppFont.semibold,
                              letterSpacing: 0.7,
                            ),
                          ),
                          const SizedBox(height: 1),
                          _line(status, invite),
                        ],
                      ),
                    ),
                    if (!invite)
                      Icon(
                        Icons.chevron_right,
                        size: 16,
                        color: grid.AppPalette.textSecondary,
                      ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  /// The value line, in its three readings.
  Widget _line(DialStatus status, bool invite) {
    final base = TextStyle(
      color: grid.AppPalette.textSecondary,
      fontFamily: grid.AppFont.sans,
      fontFamilyFallback: grid.AppFont.sansFallback,
      fontSize: 12.5,
    );
    if (invite) {
      return Text.rich(
        TextSpan(
          style: base,
          children: [
            const TextSpan(text: 'Harness device · '),
            TextSpan(
              text: 'Get the device →',
              style: TextStyle(
                color: grid.AppPalette.accentOnSurface,
                fontWeight: grid.AppFont.medium,
              ),
            ),
          ],
        ),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      );
    }
    if (status.attached) {
      // The name alone. Version and port belong to the card this opens — on the row they were two
      // more things to read for a fact the green ring already tells.
      return Text(
        'Harness device',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: base.copyWith(
          color: grid.AppPalette.textPrimary,
          fontWeight: grid.AppFont.medium,
        ),
      );
    }
    return Text(
      'Harness device · unplugged',
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: base,
    );
  }

  Future<void> _showStatus(BuildContext context) {
    return showDialog<void>(
      context: context,
      barrierColor: Colors.black.withValues(alpha: 0.42),
      builder: (context) => _DeviceStatusCard(notifier: widget.notifier),
    );
  }
}

/// The mark: a solid dot in the avatar's 32px box, so it sits on the account row's column.
///
/// Solid, not a ring — a ring read as "empty", which is the opposite of a device that is on. Lit, it
/// wears a soft halo out to 20px so it carries about the avatar's weight beside it; unplugged, the halo
/// goes and the dot turns the rail's faint grey. Same dot, two states, nothing to re-learn.
class _Dot extends StatelessWidget {
  const _Dot({required this.live});

  final bool live;

  @override
  Widget build(BuildContext context) {
    final color = live ? grid.AppPalette.online : grid.AppPalette.textFaint;
    return SizedBox(
      width: 32,
      height: 32,
      child: Center(
        child: Container(
          key: const Key('device-dot'),
          width: 12,
          height: 12,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color,
            boxShadow: live
                ? [
                    BoxShadow(
                      color: color.withValues(alpha: 0.2),
                      spreadRadius: 4,
                    ),
                  ]
                : null,
          ),
        ),
      ),
    );
  }
}

/// What the row opens: the dial's status, three lines, and where the settings are.
///
/// Deliberately not a settings screen. The device keeps its own (brightness, voice language, reset —
/// its last screen), and the window saying so is worth more than the window copying them.
class _DeviceStatusCard extends StatelessWidget {
  const _DeviceStatusCard({required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: notifier.dial,
      builder: (context, _) {
        final status = notifier.dial.status;
        final updating = status.updating;
        final sub = TextStyle(
          color: grid.AppPalette.textSecondary,
          fontFamily: grid.AppFont.sans,
          fontSize: 12.5,
          height: 1.45,
        );
        return Dialog(
          backgroundColor: grid.AppGlass.surfaceFill,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(13),
            side: BorderSide(color: grid.AppGlass.hair),
          ),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 18, 20, 14),
                  child: Row(
                    children: [
                      _Dial(live: status.attached),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Harness device',
                              style: TextStyle(
                                color: grid.AppPalette.textPrimary,
                                fontFamily: grid.AppFont.sans,
                                fontSize: 15,
                                fontWeight: grid.AppFont.semibold,
                              ),
                            ),
                            const SizedBox(height: 3),
                            Text.rich(
                              TextSpan(
                                style: sub,
                                children: [
                                  TextSpan(
                                    text: status.attached
                                        ? 'Connected via USB'
                                        : 'Unplugged',
                                  ),
                                  if (status.fw != null) ...[
                                    const TextSpan(text: ' · firmware '),
                                    TextSpan(
                                      text: status.fw,
                                      style: TextStyle(
                                        color: grid.AppPalette.textPrimary,
                                      ),
                                    ),
                                  ],
                                  if (updating != null) ...[
                                    const TextSpan(text: ' · '),
                                    TextSpan(
                                      text: 'updating to $updating…',
                                      style: TextStyle(
                                        color: grid.AppPalette.warn,
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                Divider(height: 1, color: grid.AppGlass.hair),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        // The one minute in which people unplug the thing — said instead of the usual
                        // line while it is running.
                        updating != null
                            ? 'Keep it plugged in'
                            : 'Settings are on the device',
                        style: TextStyle(
                          color: grid.AppPalette.textPrimary,
                          fontFamily: grid.AppFont.sans,
                          fontSize: 13.5,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        updating != null
                            ? 'The update goes over the cable and takes about a minute.'
                            : 'Swipe to its last screen: brightness, voice language, reset.',
                        style: TextStyle(
                          color: grid.AppPalette.textFaint,
                          fontFamily: grid.AppFont.sans,
                          fontSize: 11.5,
                          height: 1.4,
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.fromLTRB(20, 11, 20, 13),
                  decoration: BoxDecoration(
                    color: grid.AppPalette.cardBg,
                    border: Border(top: BorderSide(color: grid.AppGlass.hair)),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          status.attached
                              ? 'Want one for another desk?'
                              : 'Plug it into this Mac to use it.',
                          style: TextStyle(
                            color: grid.AppPalette.textFaint,
                            fontFamily: grid.AppFont.sans,
                            fontSize: 12,
                          ),
                        ),
                      ),
                      InkWell(
                        onTap: () => unawaited(
                          launchUrl(
                            Uri.parse(kDeviceStoreUrl),
                            mode: LaunchMode.externalApplication,
                          ),
                        ),
                        child: Text(
                          'Get the device →',
                          style: TextStyle(
                            color: grid.AppPalette.accentOnSurface,
                            fontFamily: grid.AppFont.sans,
                            fontSize: 12.5,
                            fontWeight: grid.AppFont.medium,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

/// The dial, as a mark: a dark disc with the bezel drawn in and a small ring at its centre.
class _Dial extends StatelessWidget {
  const _Dial({required this.live});

  final bool live;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 56,
      height: 56,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: const Color(0xFF0C0C0E),
        border: Border.all(color: const Color(0xFF2C2C31), width: 3),
      ),
      child: Center(
        child: Container(
          width: 14,
          height: 14,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(
              width: 2,
              color: live ? grid.AppPalette.online : const Color(0xFF3A3A3E),
            ),
          ),
        ),
      ),
    );
  }
}
