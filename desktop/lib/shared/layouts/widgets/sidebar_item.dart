import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../theme/app_theme.dart';
import '../../widgets/scroll_reveal_text.dart';

/// How long a row takes to settle into — or out of — being the selected one.
///
/// One duration for the whole row. Its fill, ink and rail used to move on
/// 130/140/160ms with an instant weight change on top, so a row arrived in four
/// stages within 30ms of each other: the label snapped bold, then the highlight
/// caught up. Read as sluggish even though nothing was slow.
const Duration _selectDuration = AppMotion.swap;

/// How long the hover wash takes. Shorter than the selection: hover follows the
/// pointer, and a pointer crossing the rail shouldn't leave a trail of rows
/// still catching up.
const Duration _hoverDuration = AppMotion.hover;

/// The accent rail's width, and how far left of its resting place it starts.
const double _railWidth = 3;
const double _railTravel = _railWidth * 0.6;

/// How far the icon drifts right under the pointer.
const double _iconDrift = 2;

/// One row in the sidebar: an icon, a label, and an optional trailing widget.
///
/// The sidebar's single row recipe — nav entries, the New chat action and the
/// saved conversations all use it, so they line up and highlight identically
/// instead of each inventing its own padding and hover.
class SidebarItem extends StatefulWidget {
  const SidebarItem({
    super.key,
    required this.label,
    required this.onTap,
    this.onDoubleTap,

    this.icon,
    this.leading,
    this.dimmed = false,
    this.selected = false,
    this.enabled = true,
    this.emphasized = false,
    this.trailing,
    this.trailingWidth = 24,
    this.trailingAlwaysVisible = false,
    this.badge,
    this.tooltip,
    this.revealLabelOnHover = false,
  });

  final String label;
  final VoidCallback onTap;

  /// A second way in, for rows that have something to open on a double click —
  /// renaming, in the rail's case. Null leaves the row single-click only.
  final VoidCallback? onDoubleTap;

  final IconData? icon;

  /// A mark drawn INSTEAD of [icon] — a vendor's logo, a status-coloured glyph,
  /// anything that is not a plain icon the row may tint.
  ///
  /// Handed to the row whole rather than driven by it: [icon] eases into the
  /// accent and drifts under the pointer, which is right for a nav glyph and
  /// wrong for a logo or for a colour that means "reachable". The CALLER sizes
  /// it, because a logo and a chevron-plus-dot want different widths.
  final Widget? leading;

  /// Draw the label as unreachable while leaving the row TAPPABLE.
  ///
  /// [enabled] governs both at once, which is wrong for a row that is still
  /// worth pressing but is not what it usually is — an agent cached from a
  /// machine that has since gone offline, where the tap opens the guide that
  /// explains why. Dimming it and disabling it are different claims.
  final bool dimmed;
  final bool selected;
  final bool enabled;

  /// Draws the label in the primary ink even when unselected — for the row that
  /// is the sidebar's main action ("New chat").
  final bool emphasized;

  /// Revealed on hover (e.g. a conversation's delete button).
  final Widget? trailing;

  /// Width reserved for [trailing]. Defaults to one 24px action; a row with two
  /// (like a project's menu + new-chat) passes a wider value so neither clips.
  final double trailingWidth;

  /// Keep [trailing] visible without hovering — for a live status (a chat's
  /// "typing…" cue) that has to read at a glance, not a hover-only action.
  final bool trailingAlwaysVisible;

  /// A small always-visible mark between the label and the trailing action — an
  /// unread dot on a chat that has a result waiting. Unlike [trailing] it never
  /// hides on hover, so "there's something here" survives reaching for the row's
  /// action; null on a row with nothing to flag.
  final Widget? badge;
  final String? tooltip;

  /// Let a label too long for the rail slide left under the pointer until its
  /// end is in view, instead of resting at the fade its box cuts it off in.
  ///
  /// Opt-in, because it only pays where the cut-off part is what you're hunting
  /// for: two chats can be six words of the same sentence apart. A nav entry
  /// ("Settings") is a fixed word you already know, and a label that crawled
  /// every time the pointer crossed the rail would be noise.
  final bool revealLabelOnHover;

  /// The row's left inset — where its icon starts, measured from the row's own
  /// edge. Exposed so chrome placed alongside these rows (the Settings back
  /// link) can line its glyph up with them instead of hard-coding a copy.
  static const double iconGutter = 10;

  @override
  State<SidebarItem> createState() => _SidebarItemState();
}

class _SidebarItemState extends State<SidebarItem> {
  bool _hovered = false;
  bool _pressed = false;

  void _setPressed(bool value) {
    if (!widget.enabled || _pressed == value) return;
    setState(() => _pressed = value);
  }

  void _setHovered(bool value) {
    if (_hovered == value) return;
    setState(() => _hovered = value);
  }

  @override
  Widget build(BuildContext context) {
    // The sidebar is mounted as `const AppSidebar()`, so a rebuild from the top
    // never reaches these rows — exactly the case AppTheme.watch exists for.
    // Without it the rail keeps the palette it was first painted with.
    AppTheme.watch(context);

    // Two driven values for the whole row, where there were six separate
    // implicit animations — a container, two slides, two fades and a colour
    // tween, each with its own controller, its own duration and its own dirty
    // subtree every frame. A row is one thing arriving; it animates as one.
    final row = MouseRegion(
      onEnter: (_) => _setHovered(true),
      onExit: (_) => _setHovered(false),
      // Press feedback: the row dips slightly under the pointer and springs
      // back on release. A transform, so it never nudges neighbouring rows.
      child: AnimatedScale(
        scale: _pressed ? 0.97 : 1,
        duration: AppMotion.press,
        curve: AppMotion.curve,
        child: TweenAnimationBuilder<double>(
          // No `begin`: a row that mounts already selected is settled, not
          // animating in.
          tween: Tween(end: widget.selected ? 1.0 : 0.0),
          duration: _selectDuration,
          curve: AppMotion.curve,
          builder: (context, select, _) => TweenAnimationBuilder<double>(
            tween: Tween(end: _hovered ? 1.0 : 0.0),
            duration: _hoverDuration,
            curve: AppMotion.curve,
            builder: (context, hover, _) => _SidebarRow(
              item: widget,
              select: select,
              hover: hover,
              hovered: _hovered,
              onTapDown: (_) => _setPressed(true),
              onTapUp: (_) => _setPressed(false),
              onTapCancel: () => _setPressed(false),
            ),
          ),
        ),
      ),
    );

    final tooltip = widget.tooltip;
    if (tooltip == null) return row;
    return Tooltip(message: tooltip, child: row);
  }
}

/// The row itself, painted at a given point in its selection and hover
/// transitions. Everything that used to animate on its own — the fill, the
/// label's ink, the icon's ink and drift, the rail, the trailing action — is
/// derived from [select] and [hover] here, so one frame of the transition is one
/// rebuild and one paint.
class _SidebarRow extends StatelessWidget {
  const _SidebarRow({
    required this.item,
    required this.select,
    required this.hover,
    required this.hovered,
    required this.onTapDown,
    required this.onTapUp,
    required this.onTapCancel,
  });

  final SidebarItem item;

  /// How far into being the selected row: 0 unselected, 1 selected.
  final double select;

  /// How far into being hovered: 0 off, 1 under the pointer.
  final double hover;

  /// Whether the pointer is *meant* to be on the row — which is what decides
  /// whether the trailing action can be clicked. [hover] is mid-transition for
  /// a few frames either side of that, so it can't answer this.
  final bool hovered;

  final ValueChanged<TapDownDetails> onTapDown;
  final ValueChanged<TapUpDetails> onTapUp;
  final VoidCallback onTapCancel;

  @override
  Widget build(BuildContext context) {
    const radius = BorderRadius.all(Radius.circular(8));
    // Weight tracks the selection itself, not the transition: it changes the
    // label's metrics, so it wants to happen once, at the start, rather than
    // reflowing the text somewhere in the middle of the fade.
    final strong = item.selected || item.emphasized;
    // The emphasized row carries a whisper of accent wash so it reads as the
    // primary action without turning into a loud button; the selected row keeps
    // its neutral fill and instead earns the accent rail (below).
    final resting = item.emphasized
        ? Color.lerp(AppSurface.accentWash, AppSurface.accentWashHover, hover)!
        : Color.lerp(Colors.transparent, AppSurface.hoverFill, hover)!;
    final fill = Color.lerp(resting, AppSurface.selectedFill, select)!;
    // A row's label lifts into the primary ink as it becomes the selected one,
    // on the same curve as its fill — it used to snap bold and bright a beat
    // before the highlight caught up.
    final ink = item.dimmed
        ? AppPalette.textFaint
        : Color.lerp(
            item.emphasized ? AppPalette.textPrimary : AppPalette.textSecondary,
            AppPalette.textPrimary,
            select,
          )!;

    // What the trailing action costs the label. A hover action is only *there*
    // while the pointer is on the row, so the room it needs is taken then and
    // given back on the way out: at rest the title runs the full width of the
    // row — Codex's does — instead of stopping short of a button that isn't
    // drawn. A trailing that never hides (a chevron, a live cue) keeps its room
    // permanently; it has nothing to give back.
    final reserved = item.trailing == null
        ? 0.0
        : (item.trailingAlwaysVisible ? 1.0 : hover) * item.trailingWidth;

    return Stack(
      children: [
        // The 1px breathing room is outside the fill, so neighbouring rows'
        // highlights never touch.
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 1),
          child: DecoratedBox(
            decoration: BoxDecoration(
              // Flat, like Codex — the selected row is a soft rounded fill, no
              // lift.
              color: fill,
              borderRadius: radius,
            ),
            child: Material(
              color: Colors.transparent,
              borderRadius: radius,
              child: InkWell(
                borderRadius: radius,
                onTap: item.enabled ? item.onTap : null,
                onDoubleTap: item.enabled ? item.onDoubleTap : null,
                onTapDown: onTapDown,

                onTapUp: onTapUp,
                onTapCancel: onTapCancel,
                child: SizedBox(
                  height: 36,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(
                      SidebarItem.iconGutter,
                      0,
                      5,
                      0,
                    ),
                    // The action sits *over* the row's right end rather than
                    // in the line beside it. A slot held open in the Row would
                    // be dead space on all but the one row under the pointer,
                    // and it is the widest thing in the rail: 50px of nothing
                    // at the end of every chat title, which is exactly the
                    // room those titles were short of.
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        Row(
                          children: [
                            if (item.leading != null) ...[
                              item.leading!,
                              const SizedBox(width: 10),
                            ] else if (item.icon != null) ...[
                              _RowIcon(
                                item: item,
                                select: select,
                                hover: hover,
                              ),
                              const SizedBox(width: 10),
                            ],
                            Expanded(
                              child: _RowLabel(
                                item: item,
                                ink: ink,
                                strong: strong,
                                hovered: hovered,
                              ),
                            ),
                            // An unread mark sits just left of the action,
                            // always shown — a hover that reveals the trailing
                            // action must not hide the fact there's a result
                            // waiting.
                            if (item.badge != null) ...[
                              item.badge!,
                              const SizedBox(width: 8),
                            ],
                            // The room the action will need, opened as it
                            // arrives. It is the label that gives it up, on the
                            // same curve the action fades in on, so the title
                            // shortens under the button rather than running
                            // beneath it.
                            SizedBox(width: reserved),
                          ],
                        ),
                        // Kept mounted whether or not it's showing, so hovering
                        // never changes the row's height. A persistent trailing
                        // (a live status) shows without hover; a hover action
                        // stays hidden until the pointer lands.
                        if (item.trailing != null)
                          Align(
                            alignment: Alignment.centerRight,
                            child: IgnorePointer(
                              ignoring: !hovered && !item.trailingAlwaysVisible,
                              child: Opacity(
                                opacity: item.trailingAlwaysVisible ? 1 : hover,
                                child: SizedBox(
                                  width: item.trailingWidth,
                                  height: 24,
                                  child: item.trailing,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        // Nothing to draw on the rows that aren't selected, which is all but one
        // of them — and a rail at zero opacity is still a render object to lay
        // out and a layer to composite.
        if (select > 0) _SelectionRail(select: select),
      ],
    );
  }
}

/// The row's label — and, on a row that asks for it, the reveal of whatever the
/// rail was too narrow to show.
///
/// The travelling version is mounted only while the pointer is on the row, so
/// leaving puts the label back at its start: the reveal answers "which chat is
/// this?" once, and the next hover asks the question again.
class _RowLabel extends StatelessWidget {
  const _RowLabel({
    required this.item,
    required this.ink,
    required this.strong,
    required this.hovered,
  });

  final SidebarItem item;
  final Color ink;
  final bool strong;
  final bool hovered;

  /// Pinned metrics, shared by both versions of the label: the strut is what
  /// keeps every row's text on the same baseline whatever font falls out of the
  /// fallback chain, and a travelling label that dropped it would jump a pixel
  /// as the pointer landed.
  static const _strut = StrutStyle(
    fontSize: 13.5,
    height: 1.25,
    forceStrutHeight: true,
  );

  @override
  Widget build(BuildContext context) {
    final style = TextStyle(
      color: ink,
      fontSize: 13.7,
      height: 1.25,
      fontWeight: strong ? AppFont.medium : FontWeight.w400,
    );

    if (!item.revealLabelOnHover || !hovered) {
      // The line runs to the end of its box and dissolves there rather than
      // stopping at an ellipsis — see [tailFade] for why the rail spends no
      // character on saying "there is more".
      //
      // `clip` rather than Flutter's own `TextOverflow.fade`: that one ramps
      // over the width of the "…" it stands in for (~12px at this size), and
      // the mask is what lets the rail pick that length itself.
      return ShaderMask(
        blendMode: BlendMode.dstIn,
        shaderCallback: tailFade,
        child: Text(
          item.label,
          maxLines: 1,
          softWrap: false,
          overflow: TextOverflow.clip,
          strutStyle: _strut,
          style: style,
        ),
      );
    }
    return ScrollRevealText(
      text: item.label,
      style: style,
      strutStyle: _strut,
      // A beat behind the hover preview that opens beside the row, so the two
      // read as one gesture settling rather than two things firing at once.
      startDelay: const Duration(milliseconds: 460),
    );
  }
}

/// The row's icon: it drifts right under the pointer and eases into the accent
/// as the row becomes the selected one.
class _RowIcon extends StatelessWidget {
  const _RowIcon({
    required this.item,
    required this.select,
    required this.hover,
  });

  final SidebarItem item;
  final double select;
  final double hover;

  @override
  Widget build(BuildContext context) {
    // A row's icon carries the accent whenever the row stands out — the selected
    // nav item and the emphasized action (New chat) both — so the accent reads
    // as "this is the one", matching the selected row's rail. Everything else
    // stays in ink. The on-surface accent, not the fill one: this glyph sits on
    // the row, so in dark it needs the lighter value — see [accentOnSurface].
    //
    // The emphasized row sits permanently at the far end of the same ramp the
    // selected one travels along, so it reads as prominent from the start; a
    // disabled row stops at the ink and never reaches the accent.
    final t = item.emphasized ? 1.0 : select;
    final plain = Color.lerp(
      AppPalette.textSecondary,
      AppPalette.textPrimary,
      t,
    )!;
    final ink = item.enabled
        ? Color.lerp(plain, AppPalette.accentOnSurface, t)!
        : plain;

    return Transform.translate(
      // A whisper of drift on hover, so the icon feels alive as the pointer
      // lands — nudged right, never resized.
      offset: Offset(hover * _iconDrift, 0),
      child: Icon(item.icon, size: 18, color: ink),
    );
  }
}

/// The accent rail: a slim bar hugging the selected row's left edge.
///
/// It slides in from the left and fades up, so moving the selection glides
/// rather than blinks. Drawn outside the fill so it never shifts the label, and
/// pinned inside the row's 1px vertical margin so it lines up with the rounded
/// fill. The fade rides the colour's alpha rather than an [Opacity] — wrapping
/// it in one meant an offscreen buffer every frame of the transition.
class _SelectionRail extends StatelessWidget {
  const _SelectionRail({required this.select});

  final double select;

  @override
  Widget build(BuildContext context) => Positioned(
    left: 0,
    top: 1,
    bottom: 1,
    child: Center(
      child: Transform.translate(
        offset: Offset(-_railTravel * (1 - select), 0),
        child: Container(
          width: _railWidth,
          height: 18,
          decoration: BoxDecoration(
            // Same reason as the icon — a mark on the row, so it takes the
            // on-surface accent.
            color: AppPalette.accentOnSurface.withValues(alpha: select),
            borderRadius: const BorderRadius.horizontal(
              right: Radius.circular(3),
            ),
          ),
        ),
      ),
    ),
  );
}

/// A quiet section label above a group of [SidebarItem]s ("Chats", "Workspace").
///
/// Pass [onToggle] to make the section foldable: the label then carries a
/// chevron and the whole header becomes the hit target, the way a project row
/// folds the chats under it. A project is a group you can put away, and a
/// section of loose chats is no different — leaving one of them permanently
/// open was the odd one out in the rail.
class SidebarSectionLabel extends StatefulWidget {
  const SidebarSectionLabel({
    super.key,
    required this.label,
    this.collapsed = false,
    this.onToggle,
  });

  final String label;

  /// Which way the chevron points. Ignored without [onToggle].
  final bool collapsed;

  /// Folds/unfolds the section. Null leaves the label as plain chrome.
  final VoidCallback? onToggle;

  @override
  State<SidebarSectionLabel> createState() => _SidebarSectionLabelState();
}

class _SidebarSectionLabelState extends State<SidebarSectionLabel> {
  bool _hovered = false;

  void _setHovered(bool value) {
    if (_hovered == value) return;
    setState(() => _hovered = value);
  }

  @override
  Widget build(BuildContext context) {
    // Same reason as the row above: const chrome reading a token.
    AppTheme.watch(context);
    final foldable = widget.onToggle != null;
    final hot = foldable && _hovered;
    // The label lifts out of the hint ink under the pointer, like every other
    // interactive thing in the rail — a header you can click must not sit at the
    // same tint as one you can't.
    final ink = hot ? AppPalette.textPrimary : AppPalette.textFaint;

    // 10 + 26 + 3 is the same 39px the plain label occupied (17/7 around an
    // ~15px line), and the inner 10px inset keeps its left edge in the column
    // the other section labels share — so gaining a fold costs the rail no
    // rhythm. The text rides ~1.5px higher inside that box, which is what
    // centring it against the chevron buys.
    final header = Padding(
      padding: const EdgeInsets.fromLTRB(0, 10, 0, 3),
      child: Container(
        height: 26,
        alignment: Alignment.centerLeft,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: hot ? AppSurface.hoverFill : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                widget.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: ink,
                  fontSize: 11.2,
                  fontWeight: AppFont.medium,
                  letterSpacing: 0,
                ),
              ),
            ),
            if (foldable)
              // One glyph rotated rather than two swapped: the quarter turn is
              // what shows the fold happening, and a swap would just blink.
              AnimatedRotation(
                turns: widget.collapsed ? -0.25 : 0,
                duration: AppMotion.swap,
                curve: AppMotion.curve,
                child: Icon(LucideIcons.chevronDown300, size: 14, color: ink),
              ),
          ],
        ),
      ),
    );

    if (!foldable) return header;

    return Semantics(
      button: true,
      label: '${widget.collapsed ? 'Expand' : 'Collapse'} ${widget.label}',
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => _setHovered(true),
        onExit: (_) => _setHovered(false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onToggle,
          child: header,
        ),
      ),
    );
  }
}
