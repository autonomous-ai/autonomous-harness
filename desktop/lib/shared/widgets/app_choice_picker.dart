import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'app_select_field.dart';

/// Three direct choices and an overflow menu. In the tiled layout, the fourth
/// tile holds a chosen alternative; compact legacy rows reuse their third slot.
class AppChoicePicker<T> extends StatefulWidget {
  const AppChoicePicker({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    required this.optionKey,
    required this.moreLabel,
    this.moreKey,
    this.moreLeading,
    this.preferredValues = const [],
    this.overflowFirst,
    this.showDetails = false,
    this.wrap = true,
    this.compact = false,
    this.tileSize,
    this.notifyOnReselect = false,
  });

  final T value;
  final List<SelectOption<T>> options;
  final ValueChanged<T> onChanged;
  final Key Function(T) optionKey;
  final String moreLabel;
  final Key? moreKey;
  final Widget? moreLeading;
  final List<T> preferredValues;

  /// The options the overflow menu lists FIRST, ahead of the rest.
  ///
  /// Separate from [preferredValues], which names individual values and is
  /// what decides the direct tiles; this is a KIND of option — the agent
  /// picker's domain harnesses against its plain engines. The tiles are
  /// unaffected: this only sorts what is left over, so the short list of
  /// things a person came here for is not buried under fourteen engines that
  /// differ from the three on the tiles only by name.
  final bool Function(T value)? overflowFirst;

  final bool showDetails;
  final bool wrap;
  final bool compact;
  final Size? tileSize;
  final bool notifyOnReselect;

  @override
  State<AppChoicePicker<T>> createState() => _AppChoicePickerState<T>();
}

class _AppChoicePickerState<T> extends State<AppChoicePicker<T>> {
  ({T value})? _thirdChoice;
  ({T value})? _overflowChoice;

  List<SelectOption<T>> get _orderedOptions => [
    for (final preferred in widget.preferredValues)
      ...widget.options.where((option) => option.value == preferred),
    ...widget.options.where(
      (option) => !widget.preferredValues.contains(option.value),
    ),
  ];

  @override
  void initState() {
    super.initState();
    _rememberThirdChoice();
    _rememberOverflowChoice();
  }

  @override
  void didUpdateWidget(covariant AppChoicePicker<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    _rememberThirdChoice();
    _rememberOverflowChoice();
  }

  void _rememberThirdChoice() {
    final remaining = _orderedOptions.skip(2);
    final selected = remaining
        .where((option) => option.value == widget.value)
        .firstOrNull;
    final previous = remaining
        .where((option) => option.value == _thirdChoice?.value)
        .firstOrNull;
    // Keep the extra choice available while switching between the first two.
    // If it disappears from the list, fall back to the ordinary third choice.
    final third = selected ?? previous ?? remaining.firstOrNull;
    _thirdChoice = third == null ? null : (value: third.value);
  }

  void _rememberOverflowChoice() {
    final remaining = _orderedOptions.skip(3);
    final selected = remaining
        .where((option) => option.value == widget.value)
        .firstOrNull;
    final previous = remaining
        .where((option) => option.value == _overflowChoice?.value)
        .firstOrNull;
    final choice = selected ?? previous;
    _overflowChoice = choice == null ? null : (value: choice.value);
  }

  /// [options] with the kind [AppChoicePicker.overflowFirst] names at the
  /// head, each group keeping the order it arrived in.
  List<SelectOption<T>> _overflowOrder(Iterable<SelectOption<T>> options) {
    final first = widget.overflowFirst;
    if (first == null) return options.toList();
    final head = <SelectOption<T>>[];
    final tail = <SelectOption<T>>[];
    for (final option in options) {
      (first(option.value) ? head : tail).add(option);
    }
    return [...head, ...tail];
  }

  List<SelectOption<T>> get _visibleOptions => [
    ..._orderedOptions.take(2),
    if (_thirdChoice != null)
      ...widget.options.where((option) => option.value == _thirdChoice!.value),
  ];

  void _choose(T next) {
    // Clicking the current choice is still explicit intent. Callers may need
    // to pin it against an asynchronous discovery/default update.
    if (next != widget.value || widget.notifyOnReselect) widget.onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    if (widget.tileSize != null) return _tileChoices();
    final candidates = _visibleOptions;
    if (candidates.isEmpty) return const SizedBox.shrink();
    final textStyle = TextStyle(
      fontFamily: AppFont.sans,
      fontFamilyFallback: AppFont.sansFallback,
      fontSize: 13,
      fontWeight: FontWeight.w500,
    );
    final detailStyle = textStyle.copyWith(
      fontSize: 12,
      fontWeight: FontWeight.w400,
    );
    final height = widget.showDetails
        ? (widget.compact ? 52.0 : 58.0)
        : (widget.compact ? 40.0 : 44.0);

    return LayoutBuilder(
      builder: (context, constraints) {
        final scaler = MediaQuery.textScalerOf(context);
        final painter = TextPainter(
          textDirection: Directionality.of(context),
          textScaler: scaler,
        );
        var minimumWidth = 0.0;
        var controlHeight = height;
        for (final option in candidates) {
          painter.text = TextSpan(text: option.label, style: textStyle);
          painter.layout();
          var labelWidth = painter.width;
          var textHeight = painter.height;
          if (widget.showDetails && option.detail != null) {
            painter.text = TextSpan(text: option.detail, style: detailStyle);
            painter.layout();
            labelWidth = math.max(labelWidth, painter.width);
            textHeight += painter.height + 2;
          }
          controlHeight = math.max(
            controlHeight,
            textHeight + (widget.compact ? 16 : 20),
          );
          // Long custom names truncate with their full text in the tooltip.
          // Larger system text gets wider choices and additional rows.
          final width =
              math.min(labelWidth, scaler.scale(13) * 9) +
              (option.leading == null ? 0 : 26) +
              (widget.compact ? 34 : 42);
          minimumWidth = math.max(minimumWidth, width);
        }
        painter.dispose();
        const gap = 8.0;
        final moreWidth = widget.compact ? 40.0 : 44.0;
        var visible = candidates;
        if (!widget.wrap) {
          var count = candidates.length;
          while (count > 1) {
            final needed =
                minimumWidth * count +
                gap * (count - 1) +
                (widget.options.length > count ? moreWidth + gap : 0);
            if (needed <= constraints.maxWidth) break;
            count--;
          }
          visible = candidates.take(count).toList();
          final selected = candidates
              .where((option) => option.value == widget.value)
              .firstOrNull;
          if (selected != null &&
              !visible.any((option) => option.value == widget.value)) {
            visible[visible.length - 1] = selected;
          }
        }
        final hasMore = widget.options.length > visible.length;
        final rowWidth =
            (constraints.maxWidth -
                (hasMore ? moreWidth + gap : 0) -
                gap * (visible.length - 1)) /
            visible.length;
        final pairWidth = (constraints.maxWidth - gap) / 2;
        final buttonWidth = !widget.wrap || rowWidth >= minimumWidth
            ? rowWidth
            : pairWidth >= minimumWidth
            ? pairWidth
            : constraints.maxWidth;

        final children = <Widget>[
          for (final option in visible)
            SizedBox(
              width: buttonWidth,
              child: _choice(option, textStyle, detailStyle, controlHeight),
            ),
          if (hasMore)
            Semantics(
              label: widget.moreLabel,
              button: true,
              child: Tooltip(
                message: widget.moreLabel,
                child: AppSelectField<T>(
                  key: widget.moreKey,
                  value: widget.value,
                  options: _overflowOrder(widget.options),
                  onChanged: _choose,
                  filterable: true,
                  width: moreWidth,
                  height: controlHeight,
                  trigger: Icon(
                    Icons.more_horiz,
                    size: 20,
                    color: AppPalette.textSecondary,
                  ),
                ),
              ),
            ),
        ];
        return widget.wrap
            ? Wrap(spacing: gap, runSpacing: gap, children: children)
            : Row(
                children: [
                  for (var i = 0; i < children.length; i++) ...[
                    if (i > 0) const SizedBox(width: gap),
                    children[i],
                  ],
                ],
              );
      },
    );
  }

  Widget _tileChoices() {
    final ordered = _orderedOptions;
    final extra = ordered
        .skip(3)
        .where((option) => option.value == _overflowChoice?.value)
        .firstOrNull;
    final selectedExtra = extra != null && extra.value == widget.value;
    final size = widget.tileSize!;
    return Wrap(
      spacing: AppChoiceTile.gap,
      runSpacing: AppChoiceTile.gap,
      children: [
        for (final option in ordered.take(3))
          AppChoiceTile(
            key: widget.optionKey(option.value),
            size: size,
            label: option.label,
            detail: option.detail,
            leading: option.leading?.call(),
            selected: widget.value == option.value,
            onPressed: () => _choose(option.value),
          ),
        if (ordered.length > 3)
          Semantics(
            selected: selectedExtra,
            inMutuallyExclusiveGroup: true,
            child: AppSelectField<T>(
              key: widget.moreKey,
              value: widget.value,
              options: _overflowOrder(ordered.skip(3)),
              onChanged: _choose,
              filterable: true,
              width: size.width,
              height: size.height,
              padding: AppChoiceTile.padding,
              selected: selectedExtra,
              fillColor: selectedExtra
                  ? AppPalette.swarmAccent.withValues(alpha: .16)
                  : AppSurface.recess,
              trigger: AppChoiceTileContent(
                label: extra?.label ?? widget.moreLabel,
                detail: extra?.detail,
                leading: extra == null
                    ? widget.moreLeading
                    : extra.leading?.call(),
                trailing: const Icon(Icons.keyboard_arrow_down, size: 18),
              ),
            ),
          ),
      ],
    );
  }

  Widget _choice(
    SelectOption<T> option,
    TextStyle textStyle,
    TextStyle detailStyle,
    double height,
  ) {
    final selected = widget.value == option.value;
    final foreground = widget.compact
        ? AppPalette.textPrimary
        : selected
        ? AppPalette.accentOnSurface
        : AppPalette.textPrimary;
    return Semantics(
      selected: selected,
      inMutuallyExclusiveGroup: true,
      child: TextButton(
        key: widget.optionKey(option.value),
        onPressed: () => _choose(option.value),
        style:
            TextButton.styleFrom(
              foregroundColor: foreground,
              backgroundColor: widget.compact
                  ? (selected ? AppSurface.recess : Colors.transparent)
                  : selected
                  ? AppPalette.accentOnSurface.withValues(alpha: .16)
                  : AppSurface.recess,
              minimumSize: Size(0, height),
              padding: EdgeInsets.symmetric(
                horizontal: 10,
                vertical: widget.compact ? 8 : 10,
              ),
              textStyle: textStyle,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(10),
              ),
            ).copyWith(
              side: WidgetStateProperty.resolveWith(
                (states) => BorderSide(
                  color: states.contains(WidgetState.focused)
                      ? AppPalette.accentOnSurface
                      : widget.compact
                      ? (selected
                            ? AppPalette.accentOnSurface.withValues(alpha: .6)
                            : AppGlass.hair)
                      : Colors.transparent,
                ),
              ),
            ),
        child: Row(
          children: [
            if (option.leading != null) ...[
              IconTheme(
                data: IconThemeData(size: 18, color: foreground),
                child: option.leading!(),
              ),
              const SizedBox(width: 8),
            ],
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    option.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (widget.showDetails && option.detail != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      option.detail!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: detailStyle.copyWith(
                        color: selected ? foreground : AppPalette.textSecondary,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 6),
            SizedBox(
              width: 16,
              child: selected
                  ? const ExcludeSemantics(child: Icon(Icons.check, size: 16))
                  : null,
            ),
          ],
        ),
      ),
    );
  }
}

/// A shared tile keeps engine, machine and project rows on the same grid.
class AppChoiceTile extends StatelessWidget {
  static const double gap = 12;
  static const padding = EdgeInsets.symmetric(horizontal: 18, vertical: 16);

  const AppChoiceTile({
    super.key,
    required this.size,
    required this.label,
    required this.onPressed,
    this.detail,
    this.leading,
    this.selected = false,
    this.focusNode,
  });
  final Size size;
  final String label;
  final String? detail;
  final Widget? leading;
  final bool selected;
  final VoidCallback? onPressed;
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size.width,
    height: size.height,
    child: Semantics(
      selected: selected,
      inMutuallyExclusiveGroup: true,
      child: TextButton(
        focusNode: focusNode,
        onPressed: onPressed,
        style:
            TextButton.styleFrom(
              foregroundColor: AppPalette.textPrimary,
              backgroundColor: selected
                  ? AppPalette.swarmAccent.withValues(alpha: .16)
                  : AppSurface.recess,
              padding: padding,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(AppControl.radius),
              ),
            ).copyWith(
              side: WidgetStateProperty.resolveWith(
                (states) => BorderSide(
                  color: selected
                      ? AppPalette.swarmAccent.withValues(alpha: .7)
                      : Colors.transparent,
                ),
              ),
            ),
        child: AppChoiceTileContent(
          label: label,
          detail: detail,
          leading: leading,
        ),
      ),
    ),
  );
}

class AppChoiceTileContent extends StatelessWidget {
  const AppChoiceTileContent({
    super.key,
    required this.label,
    this.detail,
    this.leading,
    this.trailing,
  });
  final String label;
  final String? detail;
  final Widget? leading, trailing;

  /// The name's type, and the detail's under it. Written down because the tile
  /// height is arithmetic over exactly these numbers — see [linesFor] and the
  /// New Harness dialog's `tileSize`.
  static const double labelSize = 16;
  static const double detailSize = 14;
  static const double lineHeight = 1.25;
  static const double lineGap = 4;

  /// How many lines of each the tile has room for, at [room] points of height.
  ///
  /// ⚠️ The tile is a FIXED box, so this is not cosmetic: a column that asks
  /// for more than it was given overflows, which in a test is an exception and
  /// on screen is a striped bar. Both lines want two and most tiles can afford
  /// three between them, so one of them spends its second — and it is the
  /// DETAIL that gets it when the name fits on one line, because "Documents ·
  /// Typst GmbH" is the string that was arriving as "Documents · Typst Gm…".
  /// A name that genuinely wraps keeps its second line, and the detail gives
  /// its own up: a truncated name is the worse of the two.
  static ({int label, int detail}) linesFor({
    required double room,
    required bool labelWraps,
    required bool hasDetail,
    required TextScaler scaler,
  }) {
    if (!hasDetail) return (label: 2, detail: 0);
    final labelLine = scaler.scale(labelSize) * lineHeight;
    final detailLine = scaler.scale(detailSize) * lineHeight;
    bool fits(int label, int detail) =>
        !room.isFinite ||
        label * labelLine + lineGap + detail * detailLine <= room;
    for (final lines
        in labelWraps
            ? const [(2, 2), (2, 1), (1, 2)]
            : const [(2, 2), (1, 2), (2, 1)]) {
      if (fits(lines.$1, lines.$2)) {
        return (label: lines.$1, detail: lines.$2);
      }
    }
    return (label: 1, detail: 1);
  }

  @override
  Widget build(BuildContext context) {
    final labelStyle = TextStyle(
      fontFamily: AppFont.sans,
      fontFamilyFallback: AppFont.sansFallback,
      fontSize: labelSize,
      height: lineHeight,
      fontWeight: AppFont.medium,
      color: AppPalette.textPrimary,
    );
    return Row(
      children: [
        if (leading != null) ...[leading!, const SizedBox(width: 12)],
        Expanded(
          // Inside the Expanded, so the constraints are the text column's own:
          // the width the name is measured against and the height the two of
          // them have to share.
          child: LayoutBuilder(
            builder: (context, constraints) {
              final scaler = MediaQuery.textScalerOf(context);
              final painter = TextPainter(
                text: TextSpan(text: label, style: labelStyle),
                textDirection: Directionality.of(context),
                textScaler: scaler,
                maxLines: 1,
              )..layout(maxWidth: constraints.maxWidth);
              final labelWraps = painter.didExceedMaxLines;
              painter.dispose();
              final lines = linesFor(
                room: constraints.maxHeight,
                labelWraps: labelWraps,
                hasDetail: detail != null,
                scaler: scaler,
              );
              return Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    maxLines: lines.label,
                    overflow: TextOverflow.ellipsis,
                    style: labelStyle,
                  ),
                  if (detail != null) ...[
                    const SizedBox(height: lineGap),
                    Text(
                      detail!,
                      maxLines: lines.detail,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontFamily: AppFont.sans,
                        fontFamilyFallback: AppFont.sansFallback,
                        fontSize: detailSize,
                        height: lineHeight,
                        color: AppPalette.textSecondary,
                      ),
                    ),
                  ],
                ],
              );
            },
          ),
        ),
        if (trailing != null) ...[
          const SizedBox(width: 8),
          SizedBox(width: 18, child: trailing),
        ],
      ],
    );
  }
}
