import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'app_menu.dart';

/// One choice in an [AppSelectField].
@immutable
class SelectOption<T> {
  const SelectOption({
    required this.value,
    required this.label,
    this.note,
    this.detail,
    this.leading,
    this.trailing,
  });

  final T value;
  final String label;

  /// A sentence UNDER the label, for a list whose labels alone do not say what
  /// picking one does.
  ///
  /// Distinct from [note], which sits beside the label and qualifies the same
  /// noun. A sentence cannot go there: the closed field is only as wide as the
  /// control, so it would arrive clipped mid-clause. Shown in the OPEN menu
  /// only, which is where it is needed — while choosing, not after.
  final String? detail;

  /// A mark shown before the label, in the row AND in the closed control — an
  /// engine's logo, a colour swatch. Built fresh per use rather than shared, so
  /// the same option can appear in both places.
  final Widget Function()? leading;

  /// A short qualifier shown after the label in quieter ink — "SF Pro" beside
  /// "System", or a warning that a saved choice is no longer installed.
  final String? note;

  /// A mark at the row's far end. Built fresh per use, like [leading].
  ///
  /// For a state that recurs down the list, where the same words on several
  /// rows read as noise. Only in the open list: the closed control shows the
  /// chosen option's [note], and a glyph there would have to explain itself
  /// with no room to.
  final Widget Function()? trailing;
}

/// A control that picks one of a list, replacing [DropdownButtonFormField].
///
/// Material's dropdown is unusable here: it renders its own popup, anchors it
/// *over* the field rather than under it, forces the panel to the field's width,
/// and comes out square-cornered and edge-to-edge no matter what `borderRadius`,
/// `elevation` or `dropdownColor` you hand it — while ignoring BOTH `menuTheme`
/// and `popupMenuTheme`, so it cannot be made to match any other menu in the
/// app. Built on [MenuAnchor] instead, it takes [AppMenu]'s panel like every
/// other menu here and its rows are the app's own [AppMenuItem].
///
/// ⚠️ There is no disabled row, deliberately. A choice that is visible but
/// silently does nothing is worse than a choice that is absent — so a caller
/// with an unavailable option should drop it from [options] rather than hope
/// for a greyed-out row. The exception worth making is the option that is
/// currently SELECTED but no longer available: that one stays, with a [note]
/// saying why, because a picker that silently forgets the user's setting is the
/// same failure wearing a different hat.
class AppSelectField<T> extends StatefulWidget {
  const AppSelectField({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    this.width,
  });

  final T value;
  final List<SelectOption<T>> options;
  final ValueChanged<T> onChanged;

  /// Fixed width, so a column of these lines up on one right edge. Null lets it
  /// take whatever its parent gives.
  final double? width;

  @override
  State<AppSelectField<T>> createState() => _AppSelectFieldState<T>();
}

class _AppSelectFieldState<T> extends State<AppSelectField<T>> {
  final _controller = MenuController();
  bool _hovered = false;

  /// How tall this panel may draw.
  ///
  /// ⚠️ NOT [AppControl.menuMaxHeight]. That token's 240 is for a menu that
  /// opens UPWARD and places itself by summing the height it is about to take;
  /// this one hangs below its field, so it is free to be as tall as its own
  /// list. Left at 240, a seven-item picker overflowed by five pixels and grew
  /// a scrollbar to show them — furniture that says "there is more here" when
  /// there is not.
  ///
  /// The ceiling is still real: past it a long list scrolls instead of running
  /// off the window.
  double get _panelHeight => math.min(
    // A row with a detail line is TALLER, and the difference has to be counted
    // per row rather than assumed for all of them: a list where only some
    // options carry a sentence would otherwise be measured wrong in whichever
    // direction the guess went, and a panel that disagrees with its layout by a
    // few pixels wears a scrollbar it does not need.
    widget.options.fold<double>(
          0,
          (total, option) =>
              total +
              (option.detail == null
                  ? AppMenuRowMetrics.roomy.extent
                  : AppMenuRowMetrics.roomy.detailExtent),
        ) +
        AppMenu.panelPadding.vertical,
    _maxPanelHeight,
  );

  static const double _maxPanelHeight = 380;

  /// A floor under the panel's width, on top of the field's own.
  ///
  /// A field can be narrow — the font picker's is 188 — while its list holds
  /// names that are not. The panel is where the choosing happens, so it is
  /// allowed to be wider than the box it drops out of; the reverse, a panel
  /// narrower than its control, is what reads as an unrelated box.
  static const double _minPanelWidth = 240;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final selected = widget.options.where((o) => o.value == widget.value);
    final current = selected.isEmpty ? null : selected.first;

    // The panel is measured against the FIELD, not against its own contents: a
    // menu narrower than the control it drops out of reads as an unrelated box
    // that happened to open nearby. `widget.width` covers a fixed-size field;
    // the incoming constraint covers one that fills its parent — the case in a
    // dialog, and the one that was missed.
    return LayoutBuilder(
      builder: (context, constraints) => _anchor(
        current,
        widget.width ??
            (constraints.maxWidth.isFinite ? constraints.maxWidth : null),
      ),
    );
  }

  Widget _anchor(SelectOption<T>? current, double? panelWidth) {
    return MenuAnchor(
      controller: _controller,
      // Below the control, by the app's one menu gap — and the panel takes its
      // fill, rim and radius from [AppMenu], the app's single panel recipe.
      alignmentOffset: const Offset(0, AppControl.menuGap),
      // ⚠️ The width is set on the ROWS, not with `MenuStyle.minimumSize`.
      //
      // `minimumSize` does widen the panel, but `MenuAnchor` lays its children
      // out loose, so the rows keep their intrinsic width and sit in a wider box
      // — measured at 173 inside a panel asked for 240, which reads as a menu
      // with a mysterious margin down one side. Sizing the row makes the panel
      // follow it, and the hover pill then spans the width a person is aiming
      // at.
      style: AppMenu.style(maxHeight: _panelHeight),
      menuChildren: [
        for (final option in widget.options)
          SizedBox(
            width: math.max(panelWidth ?? 0, _minPanelWidth),
            child: AppMenuItem(
              // No glyph of its own: the leading slot belongs to the tick,
              // and stays empty (not a blank checkbox) on rows without it.
              // `selected` also carries the wash and the heavier label, so the
              // choice is marked three ways rather than by a tick alone.
              // A picker's list, not a context menu's: this menu IS the
              // control, it is read down rather than glanced at, and it is the
              // only place these choices are ever shown.
              metrics: AppMenuRowMetrics.roomy,
              selected: option.value == widget.value,
              label: option.label,
              note: option.note,
              detail: option.detail,
              leading: option.leading?.call(),
              trailing: option.trailing?.call(),
              onPressed: () {
                _controller.close();
                if (option.value != widget.value) {
                  widget.onChanged(option.value);
                }
              },
            ),
          ),
      ],
      builder: (context, controller, _) => MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: GestureDetector(
          onTap: () =>
              controller.isOpen ? controller.close() : controller.open(),
          behavior: HitTestBehavior.opaque,
          child: AnimatedContainer(
            duration: AppMotion.hover,
            curve: AppMotion.curve,
            width: widget.width,
            height: AppControl.height,
            padding: const EdgeInsets.only(left: 10, right: 8),
            decoration: BoxDecoration(
              // A recessed well rather than a bordered box: §1, depth from fill.
              color: _hovered || controller.isOpen
                  ? AppSurface.recessHover
                  : AppSurface.recess,
              borderRadius: BorderRadius.circular(AppControl.radius),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Row(
                    children: [
                      if (current?.leading != null) ...[
                        current!.leading!(),
                        const SizedBox(width: 8),
                      ],
                      Flexible(
                        child: Text(
                          current?.label ?? '—',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontFamily: AppFont.sans,
                            fontFamilyFallback: AppFont.sansFallback,
                            fontSize: AppControl.fontSize,
                            fontWeight: AppControl.fontWeight,
                            letterSpacing: AppFont.trackingFor(
                              AppControl.fontSize,
                            ),
                            color: AppPalette.textPrimary,
                          ),
                        ),
                      ),
                      if (current?.note != null) ...[
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            current!.note!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontFamily: AppFont.sans,
                              fontFamilyFallback: AppFont.sansFallback,
                              fontSize: 11.5,
                              color: AppPalette.textFaint,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                Icon(
                  Icons.expand_more_rounded,
                  size: AppControl.iconSize,
                  color: _hovered || controller.isOpen
                      ? AppPalette.textPrimary
                      : AppPalette.textSecondary,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
