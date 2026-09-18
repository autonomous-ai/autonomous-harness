import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../widgets/engine_identity.dart';
import 'store_editorial.dart';
import 'store_models.dart';

/// The curated front page. Nothing here invents availability, popularity or
/// ratings: the live catalog supplies the products; editorial supplies context.
class StoreDiscover extends StatelessWidget {
  const StoreDiscover({
    super.key,
    required this.entries,
    required this.loaded,
    required this.ratingFor,
    required this.installed,
    required this.onOpen,
    required this.onAction,
    required this.onCollection,
    required this.onAll,
    required this.onEngines,
  });

  final List<DshEntry> entries;
  final bool loaded;
  final StoreRating Function(DshEntry) ratingFor;
  final bool Function(String) installed;
  final ValueChanged<String> onOpen;
  final ValueChanged<DshEntry> onAction;
  final ValueChanged<StoreCollection> onCollection;
  final VoidCallback onAll;
  final VoidCallback onEngines;

  @override
  Widget build(BuildContext context) {
    final byId = {for (final e in entries) e.id: e};
    final featured = [
      for (final id in [
        'autonomous/blender',
        'autonomous/copper',
        'autonomous/autonomous-circuit',
        'autonomous/phaser',
      ])
        ?byId[id],
    ];
    final collections = storeCollections
        .where((c) => entries.any(c.includes))
        .toList();
    final crafts = entries
        .where((e) => !e.isEngine && !e.isViewerPackage)
        .toList();
    const picks = [
      'autonomous/text-to-cad',
      'autonomous/strudel',
      'autonomous/marp',
      'autonomous/manim',
      'autonomous/excalidraw',
      'autonomous/marimo',
      'autonomous/typst',
      'autonomous/remotion',
      'autonomous/rdkit',
    ];
    crafts.sort((a, b) {
      final ai = picks.indexOf(a.id), bi = picks.indexOf(b.id);
      return (ai < 0 ? 999 : ai).compareTo(bi < 0 ? 999 : bi);
    });
    final engines = [
      for (final id in ['codex', 'claude', 'opencode']) ?byId[id],
    ];
    return LayoutBuilder(
      builder: (context, constraints) {
        final padding = constraints.maxWidth < 680 ? 20.0 : 36.0;
        return SingleChildScrollView(
          key: const PageStorageKey('store-discover-scroll'),
          padding: EdgeInsets.fromLTRB(padding, 28, padding, 48),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Discover',
                    style: TextStyle(
                      fontSize: 30,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -.8,
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Your next superpower starts here.',
                    style: TextStyle(
                      fontSize: 14,
                      color: grid.AppPalette.textSecondary,
                    ),
                  ),
                  const SizedBox(height: 24),
                  if (featured.isNotEmpty)
                    _Feature(
                      entry: featured.first,
                      onOpen: () => onOpen(featured.first.id),
                    )
                  else if (!loaded)
                    const SkeletonBlock(
                      child: Skeleton(height: 340, radius: 18),
                    ),
                  if (collections.isNotEmpty) ...[
                    const SizedBox(height: 22),
                    LayoutBuilder(
                      builder: (context, box) {
                        final columns = box.maxWidth >= 780
                            ? 3
                            : box.maxWidth >= 540
                            ? 2
                            : 1;
                        final width =
                            (box.maxWidth - (columns - 1) * 18) / columns;
                        return Wrap(
                          spacing: 18,
                          runSpacing: 18,
                          children: [
                            for (final collection in collections)
                              SizedBox(
                                width: width,
                                child: _CollectionCard(
                                  collection: collection,
                                  entries: entries
                                      .where(collection.includes)
                                      .toList(),
                                  onTap: () => onCollection(collection),
                                ),
                              ),
                          ],
                        );
                      },
                    ),
                  ],
                  if (crafts.isNotEmpty) ...[
                    const SizedBox(height: 34),
                    _Heading(
                      'More to explore',
                      action: 'See all',
                      onTap: onAll,
                    ),
                    const SizedBox(height: 10),
                    StoreListing(
                      entries: crafts.take(9).toList(),
                      ratingFor: ratingFor,
                      installed: installed,
                      onOpen: onOpen,
                      onAction: onAction,
                    ),
                  ],
                  if (engines.isNotEmpty) ...[
                    const SizedBox(height: 30),
                    _Heading(
                      'Coding engines',
                      action: 'See all',
                      onTap: onEngines,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Your everyday companions for building software.',
                      style: TextStyle(
                        fontSize: 13,
                        color: grid.AppPalette.textSecondary,
                      ),
                    ),
                    const SizedBox(height: 10),
                    StoreListing(
                      entries: engines,
                      ratingFor: ratingFor,
                      installed: installed,
                      onOpen: onOpen,
                      onAction: onAction,
                    ),
                  ],
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.title, {required this.action, required this.onTap});
  final String title;
  final String action;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: Text(
          title,
          style: TextStyle(
            fontSize: 21,
            fontWeight: FontWeight.w600,
            letterSpacing: -.4,
            color: grid.AppPalette.textPrimary,
          ),
        ),
      ),
      TextButton(onPressed: onTap, child: Text(action)),
    ],
  );
}

class _Feature extends StatelessWidget {
  const _Feature({required this.entry, required this.onOpen});
  final DshEntry entry;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final story = storeStories[entry.id]!;
    return LayoutBuilder(
      builder: (context, box) {
        final narrow =
            box.maxWidth < 660 ||
            MediaQuery.textScalerOf(context).scale(14) > 20;
        final art = Image.asset(
          story.asset!,
          fit: BoxFit.cover,
          alignment: Alignment.centerRight,
          excludeFromSemantics: true,
        );
        final copy = Padding(
          padding: EdgeInsets.all(narrow ? 28 : 40),
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minHeight: narrow ? 0 : 310,
              maxWidth: narrow ? double.infinity : 470,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Text(
                  'YOUR NEXT SUPERPOWER',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.8,
                    color: Color(0xffadf3d3),
                  ),
                ),
                const SizedBox(height: 18),
                Text(
                  story.headline!,
                  style: TextStyle(
                    fontSize: narrow ? 39 : 52,
                    height: 1.02,
                    fontWeight: FontWeight.w700,
                    letterSpacing: -1.8,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  story.description!,
                  style: const TextStyle(
                    fontSize: 14,
                    height: 1.5,
                    color: Color(0xffdcece5),
                  ),
                ),
                const SizedBox(height: 24),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    EngineMark(
                      engine: entry.id,
                      displayName: entry.name,
                      size: 26,
                    ),
                    const SizedBox(width: 10),
                    Flexible(
                      child: Text(
                        entry.name,
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: Colors.white,
                        ),
                      ),
                    ),
                    const SizedBox(width: 20),
                    FilledButton(
                      onPressed: onOpen,
                      style: FilledButton.styleFrom(
                        backgroundColor: Colors.white,
                        foregroundColor: const Color(0xff132c25),
                        minimumSize: const Size(100, 36),
                        shape: const StadiumBorder(),
                      ),
                      child: const Text('Explore'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
        return Material(
          key: ValueKey('store-feature:${entry.id}'),
          color: const Color(0xff102b24),
          borderRadius: BorderRadius.circular(18),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onOpen,
            child: narrow
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      copy,
                      AspectRatio(aspectRatio: 2.1, child: art),
                    ],
                  )
                : Stack(
                    children: [
                      Positioned.fill(child: art),
                      Positioned.fill(
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            gradient: LinearGradient(
                              colors: [
                                Colors.black.withValues(alpha: .5),
                                Colors.transparent,
                              ],
                              stops: const [0, .85],
                            ),
                          ),
                        ),
                      ),
                      copy,
                    ],
                  ),
          ),
        );
      },
    );
  }
}

class _CollectionCard extends StatelessWidget {
  const _CollectionCard({
    required this.collection,
    required this.entries,
    required this.onTap,
  });
  final StoreCollection collection;
  final List<DshEntry> entries;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final withArt = [
      for (final id in collection.featuredIds)
        if (entries.any((e) => e.id == id) && storeStories[id]?.asset != null)
          id,
    ];
    final story = withArt.isEmpty ? null : storeStories[withArt.first];
    return Material(
      key: ValueKey('store-collection:${collection.id}'),
      color: grid.AppPalette.cardBg,
      borderRadius: BorderRadius.circular(14),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              height: 162,
              width: double.infinity,
              child: story?.asset != null
                  ? Image.asset(
                      story!.asset!,
                      fit: BoxFit.cover,
                      alignment: collection.id == 'shape'
                          ? const Alignment(.8, .4)
                          : Alignment.center,
                      excludeFromSemantics: true,
                    )
                  : ColoredBox(
                      color: grid.AppSurface.recess,
                      child: Center(
                        child: EngineMark(
                          engine: entries.first.id,
                          displayName: entries.first.name,
                          size: 70,
                        ),
                      ),
                    ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 17, 18, 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    collection.title,
                    style: TextStyle(
                      fontSize: 19,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -.4,
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    collection.subtitle,
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.4,
                      color: grid.AppPalette.textSecondary,
                    ),
                  ),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          '${entries.length} harness${entries.length == 1 ? '' : 'es'} to explore',
                          style: TextStyle(
                            fontSize: 11,
                            color: grid.AppPalette.textFaint,
                          ),
                        ),
                      ),
                      Icon(
                        LucideIcons.arrowRight300,
                        size: 16,
                        color: grid.AppPalette.textSecondary,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Compact, responsive rows shared by Discover, search and categories.
class StoreListing extends StatelessWidget {
  const StoreListing({
    super.key,
    required this.entries,
    required this.ratingFor,
    required this.installed,
    required this.onOpen,
    required this.onAction,
  });
  final List<DshEntry> entries;
  final StoreRating Function(DshEntry) ratingFor;
  final bool Function(String) installed;
  final ValueChanged<String> onOpen;
  final ValueChanged<DshEntry> onAction;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final columns = box.maxWidth >= 1120
          ? 3
          : box.maxWidth >= 720
          ? 2
          : 1;
      final width = (box.maxWidth - (columns - 1) * 24) / columns;
      return Wrap(
        spacing: 24,
        children: [
          for (final entry in entries)
            SizedBox(
              width: width,
              child: _ProductRow(
                key: ValueKey('store-card:${entry.id}'),
                entry: entry,
                rating: ratingFor(entry),
                installed: installed(entry.id),
                onOpen: () => onOpen(entry.id),
                onAction: () => onAction(entry),
              ),
            ),
        ],
      );
    },
  );
}

class _ProductRow extends StatelessWidget {
  const _ProductRow({
    super.key,
    required this.entry,
    required this.rating,
    required this.installed,
    required this.onOpen,
    required this.onAction,
  });
  final DshEntry entry;
  final StoreRating rating;
  final bool installed;
  final VoidCallback onOpen;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) => Material(
    color: Colors.transparent,
    child: InkWell(
      onTap: onOpen,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        constraints: const BoxConstraints(minHeight: 94),
        padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 6),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: grid.AppPalette.divider)),
        ),
        child: Row(
          children: [
            EngineMark(engine: entry.id, displayName: entry.name, size: 42),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    entry.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    storeBenefit(entry),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.3,
                      color: grid.AppPalette.textSecondary,
                    ),
                  ),
                  if (!rating.isEmpty) ...[
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Icon(
                          Icons.star_rounded,
                          size: 12,
                          color: grid.AppPalette.textSecondary,
                        ),
                        const SizedBox(width: 3),
                        Text(
                          '${rating.average.toStringAsFixed(1)} · ${rating.count}',
                          style: TextStyle(
                            fontSize: 11,
                            color: grid.AppPalette.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 12),
            TextButton(
              key: ValueKey('store-action:${entry.id}'),
              onPressed: entry.isViewerPackage ? onOpen : onAction,
              style: TextButton.styleFrom(
                backgroundColor: grid.AppSurface.selectedFill,
                foregroundColor: grid.AppPalette.accentOnSurface,
                minimumSize: const Size(62, 30),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                shape: const StadiumBorder(),
              ),
              child: Text(
                entry.isViewerPackage
                    ? 'View'
                    : entry.hasUpdate
                    ? 'Update'
                    : installed
                    ? 'Open'
                    : 'Get',
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
