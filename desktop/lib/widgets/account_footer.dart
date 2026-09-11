import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../state/app_state.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import 'link_machine_dialog.dart';
import '../settings/settings_screen.dart';

class AccountFooter extends StatefulWidget {
  final AppNotifier notifier;

  /// Draw the avatar alone, for the folded rail.
  ///
  /// Not the pill with the email hidden: at 72px a recessed pill would be a
  /// rounded box hugging a circle, which reads as a second ring around the
  /// avatar rather than as a button.
  final bool compact;

  const AccountFooter({
    super.key,
    required this.notifier,
    this.compact = false,
  });

  @override
  State<AccountFooter> createState() => _AccountFooterState();
}

class _AccountFooterState extends State<AccountFooter> {
  /// Held here because [AppMenuItem] does not close the panel for you — unlike
  /// `MenuItemButton`, which used to and was the only thing it did right.
  final _menu = MenuController();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final profile = widget.notifier.currentUser;
    final isLocal = widget.notifier.localManualFixture != null;
    final primary =
        profile?.email ?? (isLocal ? 'local terminal' : 'signed in');
    final secondary = isLocal ? 'LOCAL SESSION' : null;

    return MenuAnchor(
      controller: _menu,
      alignmentOffset: const Offset(8, -8),
      // The app's one panel recipe, with only the two things that are specific
      // to *this* menu passed in.
      //
      // The width is one of them: this panel holds an email address, and a menu
      // that resized itself to the signed-in account would move its own rows
      // between one user and the next. The height is the other — the summary
      // block plus three rows and their rules run past the 240 a plain menu is
      // capped at, and this one opens *upward*, so a cap that clipped it would
      // also lift it clear of the pill it hangs off.
      style: grid.AppMenu.style(minWidth: 276, maxWidth: 292, maxHeight: 420),
      // The same rows the machine and agent ⋯ menus use.
      //
      // These were raw `MenuItemButton`s, which take Material's M3 defaults and
      // land wrong on four counts at once: radius 0, a 14pt label, a grey
      // `onSurface`-8% hover and an ink ripple every other menu here has turned
      // off — plus a 48px tap target. The visible tell was the highlight: a
      // full-bleed band touching both panel edges, running square into a panel
      // rounded at 10. [AppMenuItem] carries a 6px gutter, so the hover reads as
      // a pill INSET in the panel, which is what the ⋯ menus already looked like.
      //
      // Icons come from the same set as those menus too. Two glyph families for
      // the same kind of row is a boundary nobody can see the logic of.
      menuChildren: [
        _AccountSummary(notifier: widget.notifier),
        const AppMenuDivider(),
        AppMenuItem(
          key: const Key('link-a-machine-menu-item'),
          icon: LucideIcons.link2300,
          label: 'Remote into another machine…',
          onPressed: () {
            _menu.close();
            unawaited(showLinkMachineDialog(context, widget.notifier));
          },
        ),
        AppMenuItem(
          key: const Key('settings-menu-item'),
          icon: LucideIcons.settings300,
          label: 'Settings',
          onPressed: () {
            _menu.close();
            unawaited(
              showSettingsScreen(
                context,
                widget.notifier,
                source: 'account_menu',
              ),
            );
          },
        ),
        const AppMenuDivider(),
        AppMenuItem(
          key: const Key('sign-out-menu-item'),
          icon: LucideIcons.logOut300,
          label: isLocal ? 'Disconnect local session' : 'Sign out',
          // The one row here that ENDS something. It sat in a group of its own
          // already, which said "this is different" — but drew in the same ink
          // as Settings, which said the opposite louder. [AppMenuItem] has
          // carried the treatment all along; this row simply never asked.
          danger: true,
          onPressed: () {
            _menu.close();
            widget.notifier.logout();
          },
        ),
      ],
      builder: (context, controller, child) => Padding(
        // The pill floats inside the rail rather than spanning it. A full-width
        // band with a rule above it reads as a second surface bolted to the
        // bottom; a recessed pill reads as part of the column it sits in.
        padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
        child: widget.compact
            ? Center(
                child: _AvatarButton(
                  onTap: controller.isOpen ? controller.close : controller.open,
                  initials: profile?.initials ?? (isLocal ? 'L' : '?'),
                ),
              )
            : _AccountPill(
                open: controller.isOpen,
                onTap: controller.isOpen ? controller.close : controller.open,
                initials: profile?.initials ?? (isLocal ? 'L' : '?'),
                primary: primary,
                secondary: secondary,
              ),
      ),
    );
  }
}

/// The row you press to reach the account menu.
///
/// Its own widget so the hover state belongs to the thing that shows it: an
/// InkWell `hoverColor` tinted the whole 66px band instead, which read as the
/// rail highlighting rather than the row.
/// The avatar as a button, for the folded rail.
class _AvatarButton extends StatelessWidget {
  const _AvatarButton({required this.onTap, required this.initials});

  final VoidCallback onTap;
  final String initials;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Tooltip(
      message: 'Account',
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          key: const Key('account-menu-button'),
          onTap: onTap,
          behavior: HitTestBehavior.opaque,
          child: _Avatar(initials: initials),
        ),
      ),
    );
  }
}

class _AccountPill extends StatefulWidget {
  const _AccountPill({
    required this.open,
    required this.onTap,
    required this.initials,
    required this.primary,
    this.secondary,
  });

  final bool open;
  final VoidCallback onTap;
  final String initials;
  final String primary;
  final String? secondary;

  @override
  State<_AccountPill> createState() => _AccountPillState();
}

class _AccountPillState extends State<_AccountPill> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final lit = _hovered || widget.open;
    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        key: const Key('account-menu-button'),
        onTap: widget.onTap,
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: grid.AppMotion.hover,
          curve: grid.AppMotion.curve,
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          decoration: BoxDecoration(
            color: lit ? grid.AppSurface.recessHover : grid.AppSurface.recess,
            borderRadius: BorderRadius.circular(11),
          ),
          child: Row(
            children: [
              _Avatar(initials: widget.initials),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.primary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: grid.AppPalette.textPrimary,
                        fontFamily: grid.AppFont.sans,
                        fontFamilyFallback: grid.AppFont.sansFallback,
                        fontSize: 13,
                        fontWeight: grid.AppFont.medium,
                      ),
                    ),
                    if (widget.secondary != null)
                      Text(
                        widget.secondary!,
                        style: TextStyle(
                          color: grid.AppPalette.textFaint,
                          fontFamily: grid.AppFont.sans,
                          fontSize: 11,
                          fontWeight: grid.AppFont.medium,
                        ),
                      ),
                  ],
                ),
              ),
              Icon(
                Icons.more_horiz,
                size: 18,
                color: grid.AppPalette.textSecondary,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AccountSummary extends StatelessWidget {
  final AppNotifier notifier;

  const _AccountSummary({required this.notifier});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final profile = notifier.currentUser;
    final isLocal = notifier.localManualFixture != null;
    return Padding(
      // 15 = the row gutter (6) plus a row's own inner padding (9), so this
      // block starts on the same left edge as the glyphs under it instead of
      // one pixel off it.
      padding: const EdgeInsets.fromLTRB(15, 10, 15, 8),
      child: Row(
        children: [
          _Avatar(
            initials: profile?.initials ?? (isLocal ? 'L' : '?'),
            large: true,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  profile?.displayName ??
                      (isLocal ? 'Local session' : 'Autonomous user'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  // Semibold, not w700: the weight ladder has three steps and
                  // this is the top one. A fourth weight for one line makes it
                  // shout at the rows it is introducing.
                  style: TextStyle(
                    color: grid.AppPalette.textPrimary,
                    fontFamily: grid.AppFont.sans,
                    fontFamilyFallback: grid.AppFont.sansFallback,
                    fontSize: 13.5,
                    // 1.25, not the 1.2 a row uses: this line has a second line
                    // under it, and a name and its address set solid read as one
                    // block of text rather than as a heading and its subtitle.
                    height: 1.25,
                    // From the ladder, like the address under it — not a hand
                    // -picked value. Two lines this close with tracking set on
                    // only one of them drift apart at the right edge.
                    letterSpacing: grid.AppFont.trackingFor(13.5),
                    fontWeight: grid.AppFont.semibold,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  profile?.email ??
                      (isLocal ? 'loopback backend' : 'profile unavailable'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: grid.AppPalette.textSecondary,
                    fontFamily: grid.AppFont.sans,
                    fontFamilyFallback: grid.AppFont.sansFallback,
                    fontSize: 12,
                    height: 1.25,
                    letterSpacing: grid.AppFont.trackingFor(12),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  final String initials;
  final bool large;

  const _Avatar({required this.initials, this.large = false});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final size = large ? 36.0 : 32.0;
    return Container(
      // Keyed so the rows that stand on this pill's column can prove, in a
      // test, that they do — the device row above it measures its mark
      // against this centre.
      key: const Key('account-avatar'),
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        // A filled disc, not a ring. The ring read as a third border stacked
        // inside the pill's own rounding; a solid mark is what makes an avatar
        // look like a person rather than like another control.
        color: grid.AppPalette.avatarFill,
        shape: BoxShape.circle,
      ),
      child: Text(
        initials,
        style: TextStyle(
          // White on the accent disc — the token pair the palette is built for
          // (5.5:1). The page ink would be near-black in Light and vanish.
          color: Colors.white,
          fontSize: large ? 12 : 11,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
