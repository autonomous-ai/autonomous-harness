import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';
import 'sidebar_item.dart';

/// How many rows a *nested* sidebar section shows before the rest sit behind
/// "Show more".
///
/// Small on purpose: the rail is a way back to the chat you were just in, and a
/// section that opens at twenty rows buries the three that matter under
/// seventeen that don't.
///
/// One number for both of them — the project list, and the chats inside a
/// project — so those two can't grow differently-sized pages. The loose chats
/// are the exception and page at [kSidebarChatsFirstPage]; see there for why
/// that one list earns a longer opening.
const int kSidebarFirstPage = 5;

/// How many chats the rail's "Chats" section shows before the rest sit behind
/// "Show more".
///
/// Four times [kSidebarFirstPage], because nothing else in the rail stands in
/// for this list. A project's chats are one click away inside a folder you can
/// already see, so cutting that list short costs you nothing you can't find;
/// a chat that belongs to no project is in this list or nowhere. Opening it at
/// five made "Show more" the row a person clicked most.
///
/// It doubles as the threshold, which is the point of stating it as the first
/// page rather than as a separate rule: a section is truncated only when it has
/// more rows than it shows, so nineteen loose chats are simply all drawn and
/// "Show more" is never built.
const int kSidebarChatsFirstPage = 20;

/// How many more rows each click of "Show more" reveals.
///
/// **Bigger than [kSidebarFirstPage], deliberately.** The two answer different
/// questions. That first page is what the rail volunteers, so it stays short;
/// a click is someone saying "I don't see it, show me more", and answering that
/// five at a time makes them click four times to reach a chat from last week.
/// Whoever asked has already told you they want a longer list.
///
/// One step for every section, including the one that opens at
/// [kSidebarChatsFirstPage] and so reveals *fewer* rows per click than it began
/// with: what a click is worth doesn't change with how much the rail chose to
/// show before it.
const int kSidebarNextPage = 10;

/// How many rows a section shows once it has been paged open [pages] times:
/// [firstPage], then [kSidebarNextPage] more for every click after.
///
/// A function rather than the arithmetic at each call site, so the three
/// sections can't drift apart on the *step* even where they deliberately differ
/// on the opening page, and so the count is always clamped to what's actually
/// there: a section expanded past a list that later shrank (a chat archived, a
/// project removed) must not keep claiming there's more to see.
int sidebarPageCount(
  int pages,
  int total, {
  int firstPage = kSidebarFirstPage,
}) {
  final shown = pages <= 1
      ? firstPage
      : firstPage + kSidebarNextPage * (pages - 1);
  return shown < total ? shown : total;
}

/// The row that closes a truncated sidebar section: quiet text that reveals the
/// next [kSidebarNextPage] rows, and stops being built once the list is fully
/// shown.
///
/// Deliberately lighter than a [SidebarItem] — shorter, smaller, faint until you
/// reach for it. It's chrome *about* the list, not an entry *in* it, so it must
/// not read as one more chat you could open.
class SidebarShowMore extends StatefulWidget {
  const SidebarShowMore({
    super.key,
    required this.remaining,
    required this.onTap,
    this.indented = false,
  });

  /// How many rows are still hidden — carried in the tooltip, so the row itself
  /// stays the same two words at every list length.
  final int remaining;

  final VoidCallback onTap;

  /// Line the label up with the chats it follows: a project's chats, and the
  /// loose ones, are indented one step. The row under the project *list* stays
  /// out at the rail's edge, which is what tells you it belongs to the section
  /// rather than to the chats of the last project above it.
  final bool indented;

  @override
  State<SidebarShowMore> createState() => _SidebarShowMoreState();
}

class _SidebarShowMoreState extends State<SidebarShowMore> {
  bool _hovered = false;

  void _setHovered(bool value) {
    if (_hovered == value) return;
    setState(() => _hovered = value);
  }

  @override
  Widget build(BuildContext context) {
    // Reads AppPalette/AppSurface from inside the rail's lazy list — watch here
    // or this row keeps the palette it was first painted with.
    AppTheme.watch(context);
    final hot = _hovered;
    // Rests at the hint ink so a truncated section stays quiet, and climbs to
    // the primary ink under the pointer: an affordance that stays dim while
    // you're aiming at it reads as a caption, not a control.
    final ink = hot ? AppPalette.textPrimary : AppPalette.textFaint;

    return Padding(
      // The same 28px step a chat row takes, plus the 1px of vertical breathing
      // room every rail row keeps, so neighbouring highlights never touch.
      padding: EdgeInsets.only(
        left: widget.indented ? 28 : 0,
        top: 1,
        bottom: 1,
      ),
      child: Semantics(
        button: true,
        label: 'Show more',
        child: Tooltip(
          message: '${widget.remaining} more',
          child: MouseRegion(
            cursor: SystemMouseCursors.click,
            onEnter: (_) => _setHovered(true),
            onExit: (_) => _setHovered(false),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: widget.onTap,
              child: AnimatedContainer(
                duration: AppMotion.hover,
                curve: AppMotion.curve,
                height: 30,
                alignment: Alignment.centerLeft,
                padding: const EdgeInsets.symmetric(
                  horizontal: SidebarItem.iconGutter,
                ),
                decoration: BoxDecoration(
                  color: hot ? AppSurface.hoverFill : Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  'Show more',
                  style: TextStyle(
                    color: ink,
                    fontSize: 12.5,
                    fontWeight: AppFont.medium,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
