import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../analytics/analytics.dart';
import '../core/dsh_catalog.dart';
import '../core/test_run.dart';
import '../shared/layouts/widgets/sidebar_item.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../widgets/engine_identity.dart';
import '../widgets/new_agent_dialog.dart';
import 'store_controller.dart';
import 'store_discover.dart';
import 'store_editorial.dart';
import 'store_models.dart';

/// Store tabs reuse the app icon.
const String kStoreMarkAsset = 'assets/app_icon.png';

/// The Harness Store, the content of its tab: every harness the registry
/// knows and every built-in engine, as a shelf of cards; one becomes its page
/// — what it is, whose it is, where it is installed, what people think of it —
/// with Get, Open and Remove. A tab, not a screen over the window, so the
/// strip stays where it is and browsing never blocks switching.
///
/// The catalogue is what the machines answered `dsh_list` with, so the same
/// screen is honest about the one fact an app store usually hides: a harness
/// is installed PER MACHINE. The page lists your machines and lets you put it
/// on any of them. Ratings and reviews come from the control plane through
/// [StoreApi]; the screen works without them (a page simply has no stars).
class StoreTab extends StatefulWidget {
  const StoreTab({
    super.key,
    required this.notifier,
    this.source = 'unknown',
    this.api,
    this.initialHarness,
  });

  final AppNotifier notifier;
  final String source;

  /// The ratings backend; null takes the real one through the local CLI.
  final StoreApi? api;

  /// Open straight on this harness's page.
  final String? initialHarness;

  @override
  State<StoreTab> createState() => _StoreTabState();
}

/// What the rail selects: discovery, search, or a category.
sealed class _Shelf {
  const _Shelf();
}

class _Discover extends _Shelf {
  const _Discover();
}

class _All extends _Shelf {
  const _All();
}

class _Search extends _Shelf {
  const _Search(this.query);
  final String query;
}

class _Collection extends _Shelf {
  const _Collection(this.collection);
  final StoreCollection collection;
}

class _Category extends _Shelf {
  const _Category(this.name);
  final String name;
}

class _StoreTabState extends State<StoreTab> {
  late final StoreController _store = StoreController(
    widget.api ?? ApiStoreApi(widget.notifier.api),
  );
  _Shelf _shelf = const _Discover();
  late String? _selected = widget.initialHarness;
  final _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    analytics.screenView('store', source: widget.source);
    // Deferred a frame: both calls notify listeners at once, and this screen
    // is built while the shell underneath — which listens to the same
    // notifier — is mid-build.
    // Under test, only an injected [StoreApi] loads: the real one is an HTTP
    // call with a timeout, which is a Timer a widget test cannot let end.
    if (widget.api == null && kUnderTest) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(_store.loadRatings());
      // Every machine is asked again: what the store shows as installed is a
      // per-machine fact, and an install started from a terminal is exactly
      // what a stored answer misses.
      for (final machine in widget.notifier.machineStates.values) {
        final id = machine.machine.machineId;
        unawaited(widget.notifier.probeDsh(id, force: true));
        // The engine rows read the same probe the New Harness dialog does; a
        // machine that has never been asked would show Claude Code as absent.
        unawaited(widget.notifier.probeEngines(id, force: true));
      }
    });
  }

  @override
  void dispose() {
    _search.dispose();
    _store.dispose();
    super.dispose();
  }

  /// One row per harness id across every machine, the local machine's row
  /// winning (its catalog carries the whole registry) — and one row per
  /// built-in engine, because a person looking for "Claude Code" in a store
  /// should find it beside Marp, not learn that it is a different kind of thing.
  Map<String, DshEntry> get _catalog {
    final rows = <String, DshEntry>{};
    final local = widget.notifier.localMachineState;
    final states = [
      ?local,
      ...widget.notifier.machineStates.values.where(
        (s) => !identical(s, local),
      ),
    ];
    for (final identity in allEngines) {
      rows[identity.id] = DshEntry(
        id: identity.id,
        name: identity.label,
        engine: identity.id,
        kind: 'engine',
        category: identity.category ?? 'Code',
        author: identity.creator,
        description: identity.blurb,
        homepage: identity.homepage,
        installed: states.any((s) => s.engines[identity.id]?.installed == true),
      );
    }
    for (final state in states) {
      for (final entry in state.dsh.entries) {
        if (!entry.isViewerPackage) rows.putIfAbsent(entry.id, () => entry);
      }
    }
    return rows;
  }

  /// The machines that have [id] installed — a harness from their catalog, an
  /// engine from their probe.
  List<MachineState> _installedOn(String id) => [
    for (final state in widget.notifier.machineStates.values)
      if (isHarnessId(id)
          ? state.dsh[id]?.installed == true
          : state.engines[id]?.installed == true)
        state,
  ];

  List<String> get _categories {
    final names = <String>{
      for (final entry in _catalog.values)
        if (!entry.isViewerPackage) storeCategoryFor(entry),
    };
    return [
      ...storeCategoryDomains.keys,
      'Other',
    ].where(names.contains).toList();
  }

  List<DshEntry> _shelved(_Shelf shelf) {
    final all = _catalog.values.toList()
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    return switch (shelf) {
      _Discover() || _All() => all.where((e) => !e.isViewerPackage).toList(),
      _Search(:final query) =>
        all.where((e) => !e.isViewerPackage && storeMatches(e, query)).toList(),
      _Collection(:final collection) => all.where(collection.includes).toList(),
      _Category(:final name) =>
        all
            .where(
              (e) =>
                  !e.isViewerPackage &&
                  storeCategoryFor(e) == name,
            )
            .toList(),
    };
  }

  void _show(_Shelf shelf) {
    _search.clear();
    setState(() {
      _shelf = shelf;
      _selected = null;
    });
  }

  void _openPage(String id) {
    analytics.screenView('store_harness', source: 'store');
    setState(() => _selected = id);
  }

  void _searchChanged(String query) => setState(() {
    _selected = null;
    _shelf = query.trim().isEmpty ? const _Discover() : _Search(query);
  });

  void _takeAction(DshEntry entry) {
    final installed = _installedOn(entry.id);
    final local = widget.notifier.localMachineState;
    final target =
        installed.where((s) => identical(s, local)).firstOrNull ??
        installed
            .where((s) => s.nodeOnline == true && !s.needsLink)
            .firstOrNull;
    if (target == null || entry.isViewerPackage) {
      _openPage(entry.id);
      return;
    }
    unawaited(
      _openStoreAgent(
        context,
        widget.notifier,
        entry,
        target.machine.machineId,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ColoredBox(
      color: grid.AppPalette.windowBg,
      child: ListenableBuilder(
        listenable: Listenable.merge([widget.notifier, _store]),
        builder: (context, _) {
          final catalog = _catalog;
          final selected = _selected == null ? null : catalog[_selected!];
          return Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _StoreNav(
                shelf: _shelf,
                categories: _categories,
                onSelect: _show,
                search: _search,
                onSearch: _searchChanged,
              ),
              VerticalDivider(width: 1, color: grid.AppPalette.divider),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(
                      child: selected != null
                          ? _ProductPage(
                              key: ValueKey('store-page:${selected.id}'),
                              entry: selected,
                              notifier: widget.notifier,
                              store: _store,
                              installedOn: _installedOn(selected.id),
                              onBack: () => setState(() => _selected = null),
                            )
                          : _shelf is _Discover
                          ? StoreDiscover(
                              entries: _shelved(const _Discover()),
                              loaded:
                                  widget
                                      .notifier
                                      .localMachineState
                                      ?.dsh
                                      .loaded ??
                                  false,
                              ratingFor: (entry) => _store.ratingOf(
                                StoreController.keyFor(entry),
                              ),
                              installed: (id) => _installedOn(id).isNotEmpty,
                              onOpen: _openPage,
                              onAction: _takeAction,
                              onCollection: (collection) =>
                                  _show(_Collection(collection)),
                              onAll: () => _show(const _All()),
                              onEngines: () => _show(const _Category('Code')),
                            )
                          : _Shelf$View(
                              shelf: _shelf,
                              entries: _shelved(_shelf),
                              store: _store,
                              installedOn: _installedOn,
                              loaded:
                                  widget
                                      .notifier
                                      .localMachineState
                                      ?.dsh
                                      .loaded ??
                                  false,
                              onOpen: _openPage,
                              onAction: _takeAction,
                            ),
                    ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

// ─── the rail ────────────────────────────────────────────────────────────────

class _StoreNav extends StatelessWidget {
  const _StoreNav({
    required this.shelf,
    required this.categories,
    required this.onSelect,
    required this.search,
    required this.onSearch,
  });

  final _Shelf shelf;
  final List<String> categories;
  final ValueChanged<_Shelf> onSelect;
  final TextEditingController search;
  final ValueChanged<String> onSearch;

  @override
  Widget build(BuildContext context) {
    final shelf = this.shelf;
    final textScale = (MediaQuery.textScalerOf(context).scale(14) / 14).clamp(
      1.0,
      1.5,
    );
    return Container(
      width:
          (MediaQuery.sizeOf(context).width < 1000 ? 184 : 216) +
          (textScale - 1) * 64,
      color: grid.AppSurface.recess,
      child: ListView(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 22),
        children: [
          TextField(
            key: const ValueKey('store-search'),
            controller: search,
            onChanged: onSearch,
            style: TextStyle(fontSize: 13, color: grid.AppPalette.textPrimary),
            decoration: InputDecoration(
              hintText: 'Search',
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(vertical: 10),
              prefixIcon: Icon(
                LucideIcons.search300,
                size: 15,
                color: grid.AppPalette.textSecondary,
              ),
              prefixIconConstraints: const BoxConstraints(minWidth: 32),
              suffixIconConstraints: const BoxConstraints(minWidth: 28),
              suffixIcon: search.text.isEmpty
                  ? null
                  : AppIconButton(
                      icon: LucideIcons.x300,
                      tooltip: 'Clear search',
                      onPressed: () {
                        search.clear();
                        onSearch('');
                      },
                    ),
            ),
          ),
          const SizedBox(height: 18),
          SidebarItem(
            key: const ValueKey('store-shelf-discover'),
            icon: LucideIcons.sparkles300,
            label: 'Discover',
            selected: shelf is _Discover,
            onTap: () => onSelect(const _Discover()),
          ),
          const SizedBox(height: 16),
          for (final name in categories)
            SidebarItem(
              key: ValueKey('store-shelf-category:$name'),
              icon: _categoryIcon(name),
              label: name,
              selected: shelf is _Category && shelf.name == name,
              onTap: () => onSelect(_Category(name)),
            ),
        ],
      ),
    );
  }
}

IconData _categoryIcon(String category) => switch (category) {
  'Design' => LucideIcons.box300,
  'Engineering' => LucideIcons.cpu300,
  'Media' => LucideIcons.film300,
  'Science' => LucideIcons.flaskConical300,
  'Code' => LucideIcons.terminal300,
  'Games' => LucideIcons.gamepad2300,
  _ => LucideIcons.shapes300,
};

// The searchable catalog, categories and curated collections use the same
// rows. Discover alone has the editorial front page.
class _Shelf$View extends StatelessWidget {
  const _Shelf$View({
    required this.shelf,
    required this.entries,
    required this.store,
    required this.installedOn,
    required this.loaded,
    required this.onOpen,
    required this.onAction,
  });

  final _Shelf shelf;
  final List<DshEntry> entries;
  final StoreController store;
  final List<MachineState> Function(String id) installedOn;
  final bool loaded;
  final ValueChanged<String> onOpen;
  final ValueChanged<DshEntry> onAction;

  String get _title => switch (shelf) {
    _Discover() => 'Discover',
    _All() => 'All harnesses',
    _Search() => 'Search results',
    _Collection(:final collection) => collection.title,
    _Category(:final name) => name,
  };

  String get _subtitle => switch (shelf) {
    _Discover() || _All() => 'Find something you have always wanted to make.',
    _Search() => '${entries.length} result${entries.length == 1 ? '' : 's'}',
    _Collection(:final collection) => collection.subtitle,
    _Category() =>
      '${entries.length} harness${entries.length == 1 ? '' : 'es'} to explore.',
  };

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    key: ValueKey('store-catalog:$_title'),
    padding: const EdgeInsets.fromLTRB(28, 28, 28, 48),
    child: Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 1440),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              _title,
              style: TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.w700,
                letterSpacing: -.6,
                color: grid.AppPalette.textPrimary,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              _subtitle,
              style: TextStyle(
                fontSize: 13,
                color: grid.AppPalette.textSecondary,
              ),
            ),
            const SizedBox(height: 24),
            if (entries.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 48),
                child: Text(
                  shelf is _Search
                      ? 'No matching harnesses. Try a name or something you want to make.'
                      : loaded
                      ? 'Nothing here yet.'
                      : 'Asking your machines…',
                  style: TextStyle(
                    fontSize: 14,
                    height: 1.5,
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
              )
            else
              StoreListing(
                entries: entries,
                ratingFor: (entry) =>
                    store.ratingOf(StoreController.keyFor(entry)),
                installed: (id) => installedOn(id).isNotEmpty,
                onOpen: onOpen,
                onAction: onAction,
              ),
          ],
        ),
      ),
    ),
  );
}

class _Stars extends StatelessWidget {
  const _Stars({super.key, required this.value, this.size = 14, this.onPick});

  /// 0..5; a half counts as a half star.
  final double value;
  final double size;

  /// When set, the stars are a picker: tapping the n-th picks n.
  final ValueChanged<int>? onPick;

  static const _amber = Color(0xffF5A623);

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 1; i <= 5; i++)
          GestureDetector(
            onTap: onPick == null ? null : () => onPick!(i),
            child: Icon(
              value >= i
                  ? Icons.star_rounded
                  : value >= i - 0.5
                  ? Icons.star_half_rounded
                  : Icons.star_outline_rounded,
              size: size,
              color: value >= i - 0.5 ? _amber : grid.AppPalette.textFaint,
            ),
          ),
      ],
    );
  }
}

// ─── the page ────────────────────────────────────────────────────────────────

Future<void> _openStoreAgent(
  BuildContext context,
  AppNotifier notifier,
  DshEntry entry,
  String machineId,
) async {
  notifier.newSwarm(draft: true);
  final target = notifier.activeSwarmId;
  if (!context.mounted) {
    notifier.cancelSwarmDraft(target);
    return;
  }
  final result = await showNewAgentDialog(
    context,
    notifier,
    machineId,
    source: 'store',
    initialEngine: entry.id,
    swarmId: target,
  );
  if (result == null) notifier.cancelSwarmDraft(target);
}

class _ProductPage extends StatefulWidget {
  const _ProductPage({
    super.key,
    required this.entry,
    required this.notifier,
    required this.store,
    required this.installedOn,
    required this.onBack,
  });

  final DshEntry entry;
  final AppNotifier notifier;
  final StoreController store;
  final List<MachineState> installedOn;
  final VoidCallback onBack;

  @override
  State<_ProductPage> createState() => _ProductPageState();
}

class _ProductPageState extends State<_ProductPage> {
  /// Machines with a Get or Remove in flight, so a double click cannot start two.
  final Set<String> _busy = {};

  String get _key => StoreController.keyFor(widget.entry);

  @override
  void initState() {
    super.initState();
    // Deferred a frame: the load's first notification would otherwise land
    // inside the build that is putting this page on screen.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(widget.store.loadReviews(_key));
    });
  }

  void _say(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _get(String machineId) async {
    // An engine is installed by the daemon on the way to the first harness
    // that needs it (`installIfMissing` on create), so Get is Open.
    if (widget.entry.isEngine) return _open(machineId);
    if (!_busy.add(machineId)) return;
    setState(() {});
    final failure = await widget.notifier.installDsh(
      machineId,
      widget.entry.id,
    );
    _busy.remove(machineId);
    if (mounted) setState(() {});
    if (failure != null) _say(failure);
  }

  Future<void> _remove(String machineId, String machineName) async {
    final ok = await showAppDialog<bool>(
      context: context,
      builder: (context) => _ConfirmCard(
        title: 'Remove ${widget.entry.name} from $machineName?',
        detail: widget.entry.linked
            ? 'This is linked to a checkout on that machine; only the link goes. Harnesses already open keep running.'
            : 'Its files and toolchain on that machine go. Harnesses already open keep running.',
        action: 'Remove',
      ),
    );
    if (ok != true || !mounted) return;
    if (!_busy.add(machineId)) return;
    setState(() {});
    final failure = await widget.notifier.removeDsh(machineId, widget.entry.id);
    _busy.remove(machineId);
    if (mounted) setState(() {});
    if (failure != null) _say(failure);
  }

  /// Open (or Get) from the store: the harness needs a tab of its own, since
  /// a pane never lands in the store tab. A draft tab is opened for it and
  /// abandoned — back to the store — if the dialog is dismissed.
  Future<void> _open(String machineId) async {
    await _openStoreAgent(context, widget.notifier, widget.entry, machineId);
  }

  Future<void> _review() async {
    final page = widget.store.reviews[_key];
    final draft = await showAppDialog<_ReviewDraft>(
      context: context,
      builder: (context) =>
          _ReviewDialog(name: widget.entry.name, existing: page?.mine),
    );
    if (draft == null || !mounted) return;
    final failure = draft.delete
        ? await widget.store.remove(_key)
        : await widget.store.submit(
            _key,
            rating: draft.rating,
            title: draft.title,
            body: draft.body,
          );
    if (failure != null) _say(failure);
  }

  @override
  Widget build(BuildContext context) {
    final entry = widget.entry;
    final identity = engineIdentity(entry.id, displayName: entry.name);
    final author = entry.author ?? identity.creator;
    final category = entry.category ?? identity.category;
    final rating = widget.store.ratingOf(_key);
    final page = widget.store.reviews[_key];
    final local = widget.notifier.localMachineState;
    final localInstalled =
        local != null &&
        (entry.isEngine
            ? local.engines[entry.id]?.installed == true
            : local.dsh[entry.id]?.installed == true);
    final machines = widget.notifier.machineStates.values.toList()
      ..sort((a, b) {
        if (identical(a, local)) return -1;
        if (identical(b, local)) return 1;
        return a.machine.displayName.toLowerCase().compareTo(
          b.machine.displayName.toLowerCase(),
        );
      });
    final base = entry.engine.isNotEmpty
        ? entry.engine
        : (knownHarnessBase[entry.id] ?? '');
    final baseLabel = base.isEmpty ? null : engineIdentity(base).label;

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(32, 12, 32, 48),
      child: Align(
        alignment: Alignment.topLeft,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 820),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextButton.icon(
                key: const ValueKey('store-back'),
                onPressed: widget.onBack,
                icon: const Icon(LucideIcons.arrowLeft300, size: 15),
                label: const Text('Back'),
                style: TextButton.styleFrom(
                  foregroundColor: grid.AppPalette.textSecondary,
                ),
              ),
              const SizedBox(height: 12),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  EngineMark(
                    engine: entry.id,
                    displayName: entry.name,
                    size: 96,
                  ),
                  const SizedBox(width: 20),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          entry.name,
                          style: TextStyle(
                            fontSize: 28,
                            fontWeight: FontWeight.w700,
                            letterSpacing: -0.5,
                            color: grid.AppPalette.textPrimary,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          [
                            ?author,
                            ?category,
                            if (entry.isViewerPackage)
                              'Viewer package'
                            else if (entry.isEngine)
                              'Coding agent'
                            else if (baseLabel != null)
                              'Runs on $baseLabel',
                          ].join(' · '),
                          style: TextStyle(
                            fontSize: 13,
                            color: grid.AppPalette.textSecondary,
                          ),
                        ),
                        if (!rating.isEmpty) ...[
                          const SizedBox(height: 10),
                          Row(
                            children: [
                              _Stars(value: rating.average, size: 16),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  rating.isEmpty
                                      ? 'No ratings yet'
                                      : '${rating.average.toStringAsFixed(1)} · ${rating.count} rating${rating.count == 1 ? '' : 's'}',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontSize: 12.5,
                                    color: grid.AppPalette.textSecondary,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(width: 16),
                  if (!entry.isViewerPackage && local != null)
                    FilledButton(
                      key: const ValueKey('store-primary-action'),
                      onPressed: _busy.contains(local.machine.machineId)
                          ? null
                          : () => localInstalled
                                ? _open(local.machine.machineId)
                                : _get(local.machine.machineId),
                      style: FilledButton.styleFrom(
                        backgroundColor: grid.AppPalette.accent,
                        foregroundColor: Colors.white,
                        minimumSize: const Size(96, 38),
                        shape: const StadiumBorder(),
                      ),
                      child: Text(localInstalled ? 'Open' : 'Get'),
                    ),
                ],
              ),
              const SizedBox(height: 24),
              if (entry.description != null)
                Text(
                  entry.description!,
                  style: TextStyle(
                    fontSize: 14,
                    height: 1.5,
                    color: grid.AppPalette.textPrimary,
                  ),
                ),
              if (storeStories[entry.id] case final story?) ...[
                const SizedBox(height: 24),
                StoreProductStory(story: story),
              ],
              if (entry.screenshots.isNotEmpty) ...[
                const SizedBox(height: 20),
                SizedBox(
                  height: 220,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: entry.screenshots.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 12),
                    itemBuilder: (context, i) => ClipRRect(
                      borderRadius: BorderRadius.circular(10),
                      child: Image.network(
                        entry.screenshots[i],
                        height: 220,
                        fit: BoxFit.cover,
                        errorBuilder: (_, _, _) => const SizedBox.shrink(),
                      ),
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 28),
              _SectionTitle('On your machines'),
              const SizedBox(height: 8),
              Container(
                decoration: BoxDecoration(
                  color: grid.AppPalette.cardBg,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: grid.AppPalette.divider),
                ),
                child: Column(
                  children: [
                    for (final (i, state) in machines.indexed) ...[
                      if (i > 0)
                        Divider(height: 1, color: grid.AppPalette.divider),
                      _MachineRow(
                        key: ValueKey(
                          'store-machine:${state.machine.machineId}',
                        ),
                        state: state,
                        entry: entry,
                        isLocal: identical(state, local),
                        busy: _busy.contains(state.machine.machineId),
                        onGet: () => _get(state.machine.machineId),
                        onRemove: () => _remove(
                          state.machine.machineId,
                          state.machine.displayName,
                        ),
                        onOpen: entry.isViewerPackage
                            ? null
                            : () => _open(state.machine.machineId),
                      ),
                    ],
                    if (machines.isEmpty)
                      Padding(
                        padding: const EdgeInsets.all(16),
                        child: Text(
                          'No machines yet.',
                          style: TextStyle(
                            fontSize: 13,
                            color: grid.AppPalette.textFaint,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              if (entry.repo != null ||
                  entry.homepage != null ||
                  entry.upstream != null ||
                  entry.license != null) ...[
                const SizedBox(height: 28),
                _SectionTitle('Links'),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    if (entry.homepage != null)
                      _LinkChip(label: 'Website', url: entry.homepage!),
                    if (entry.upstream != null)
                      _LinkChip(
                        label: 'Upstream project',
                        url: entry.upstream!,
                      ),
                    if (entry.repo != null)
                      _LinkChip(label: 'Package source', url: entry.repo!),
                    if (entry.license != null)
                      _LinkChip(label: 'Licence · ${entry.license}'),
                  ],
                ),
              ],
              if (page != null || !rating.isEmpty) ...[
                const SizedBox(height: 28),
                Row(
                  children: [
                    const Expanded(child: _SectionTitle('Ratings and reviews')),
                    TextButton(
                      key: const ValueKey('store-write-review'),
                      onPressed: _review,
                      child: Text(
                        page?.mine == null
                            ? 'Write a review'
                            : 'Edit your review',
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                if (!rating.isEmpty) _RatingSummary(rating: rating),
                if (widget.store.reviewsError[_key] != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    'Reviews are unavailable right now.',
                    style: TextStyle(
                      fontSize: 12,
                      color: grid.AppPalette.textSecondary,
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                if (page != null && page.reviews.isEmpty)
                  Text(
                    'No reviews yet. Be the first.',
                    style: TextStyle(
                      fontSize: 13,
                      color: grid.AppPalette.textFaint,
                    ),
                  ),
                for (final review in page?.reviews ?? const <StoreReview>[])
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: _ReviewCard(
                      key: ValueKey('store-review:${review.id}'),
                      review: review,
                      onEdit: review.mine ? _review : null,
                    ),
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: TextStyle(
      fontSize: 16,
      fontWeight: FontWeight.w600,
      color: grid.AppPalette.textPrimary,
    ),
  );
}

class _MachineRow extends StatelessWidget {
  const _MachineRow({
    super.key,
    required this.state,
    required this.entry,
    required this.isLocal,
    required this.busy,
    required this.onGet,
    required this.onRemove,
    required this.onOpen,
  });

  final MachineState state;
  final DshEntry entry;
  final bool isLocal;
  final bool busy;
  final VoidCallback onGet;
  final VoidCallback onRemove;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    if (entry.isEngine) return _engineRow(context);
    final row = state.dsh[entry.id];
    final run = state.dsh.runs[entry.id];
    final installing = run != null && run.inProgress;
    final installed = row?.installed == true;
    final String status;
    if (installing) {
      status = switch (run.phase) {
        'clone' => 'Fetching…',
        'setup' => 'Setting up the toolchain…',
        'doctor' => 'Checking…',
        _ => 'Installing…',
      };
    } else if (run != null && run.failed) {
      status =
          run.log.where((line) => line.startsWith('miss')).lastOrNull ??
          'Install failed';
    } else if (installed) {
      status = row?.linked == true
          ? 'Installed · linked to a checkout'
          : 'Installed';
    } else if (!state.dsh.loaded) {
      status = state.dsh.error ?? 'Asking…';
    } else {
      status = 'Not installed';
    }
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          Icon(
            isLocal ? LucideIcons.laptop300 : LucideIcons.server300,
            size: 16,
            color: grid.AppPalette.textSecondary,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isLocal
                      ? '${state.machine.displayName} · this computer'
                      : state.machine.displayName,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                    color: grid.AppPalette.textPrimary,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  status,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    color: run?.failed == true
                        ? grid.AppPalette.warn
                        : grid.AppPalette.textSecondary,
                  ),
                ),
              ],
            ),
          ),
          if (installing || busy)
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else if (installed) ...[
            if (onOpen != null)
              TextButton(
                key: ValueKey('store-open:${state.machine.machineId}'),
                onPressed: onOpen,
                child: const Text('Open'),
              ),
            TextButton(
              key: ValueKey('store-remove:${state.machine.machineId}'),
              onPressed: onRemove,
              style: TextButton.styleFrom(
                foregroundColor: grid.AppPalette.textSecondary,
              ),
              child: const Text('Remove'),
            ),
          ] else
            FilledButton.tonal(
              key: ValueKey('store-get:${state.machine.machineId}'),
              onPressed: state.dsh.loaded ? onGet : null,
              style: FilledButton.styleFrom(
                minimumSize: const Size(72, 32),
                shape: const StadiumBorder(),
              ),
              child: Text(run?.failed == true ? 'Try again' : 'Get'),
            ),
        ],
      ),
    );
  }
}

extension on _MachineRow {
  /// An engine's row: what the machine's probe said. Installed → Open; not
  /// installed but installable → Get, which opens New Harness and lets the
  /// daemon install it on the way; anything else is said and not offered.
  Widget _engineRow(BuildContext context) {
    final probe = state.engines[entry.id];
    final loaded = state.engines.loaded;
    final installed = probe?.installed == true;
    final String status;
    if (!loaded) {
      status = 'Asking…';
    } else if (installed) {
      status = 'Installed';
    } else {
      status = 'Not installed';
    }
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          Icon(
            isLocal ? LucideIcons.laptop300 : LucideIcons.server300,
            size: 16,
            color: grid.AppPalette.textSecondary,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isLocal
                      ? '${state.machine.displayName} · this computer'
                      : state.machine.displayName,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                    color: grid.AppPalette.textPrimary,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  status,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
              ],
            ),
          ),
          if (installed)
            TextButton(
              key: ValueKey('store-open:${state.machine.machineId}'),
              onPressed: onOpen,
              child: const Text('Open'),
            )
          else if (loaded && probe?.installable == true)
            FilledButton.tonal(
              key: ValueKey('store-get:${state.machine.machineId}'),
              onPressed: onGet,
              style: FilledButton.styleFrom(
                minimumSize: const Size(72, 32),
                shape: const StadiumBorder(),
              ),
              child: const Text('Get'),
            ),
        ],
      ),
    );
  }
}

class _LinkChip extends StatelessWidget {
  const _LinkChip({required this.label, this.url});
  final String label;
  final String? url;

  @override
  Widget build(BuildContext context) {
    final child = Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        color: grid.AppPalette.cardBg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: grid.AppPalette.divider),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 12.5,
              color: grid.AppPalette.textPrimary,
            ),
          ),
          if (url != null) ...[
            const SizedBox(width: 6),
            Icon(
              LucideIcons.arrowUpRight300,
              size: 13,
              color: grid.AppPalette.textFaint,
            ),
          ],
        ],
      ),
    );
    if (url == null) return child;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: () => unawaited(
          launchUrl(Uri.parse(url!), mode: LaunchMode.externalApplication),
        ),
        child: child,
      ),
    );
  }
}

class _RatingSummary extends StatelessWidget {
  const _RatingSummary({required this.rating});
  final StoreRating rating;

  @override
  Widget build(BuildContext context) {
    final max = rating.histogram.fold<int>(0, (a, b) => a > b ? a : b);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              rating.isEmpty ? '–' : rating.average.toStringAsFixed(1),
              style: TextStyle(
                fontSize: 40,
                fontWeight: FontWeight.w700,
                height: 1,
                color: grid.AppPalette.textPrimary,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'out of 5 · ${rating.count} rating${rating.count == 1 ? '' : 's'}',
              style: TextStyle(fontSize: 12, color: grid.AppPalette.textFaint),
            ),
          ],
        ),
        const SizedBox(width: 28),
        Expanded(
          child: Column(
            children: [
              for (var stars = 5; stars >= 1; stars--)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 16,
                        child: Text(
                          '$stars',
                          textAlign: TextAlign.right,
                          style: TextStyle(
                            fontSize: 11,
                            color: grid.AppPalette.textFaint,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(4),
                          child: LinearProgressIndicator(
                            minHeight: 6,
                            value: max == 0
                                ? 0
                                : rating.histogram[stars - 1] / max,
                            backgroundColor: grid.AppSurface.selectedFill,
                            color: _Stars._amber,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({super.key, required this.review, this.onEdit});
  final StoreReview review;
  final VoidCallback? onEdit;

  static String _when(DateTime at) {
    final days = DateTime.now().difference(at).inDays;
    if (days <= 0) return 'today';
    if (days == 1) return 'yesterday';
    if (days < 30) return '$days days ago';
    if (days < 365) {
      return '${days ~/ 30} month${days ~/ 30 == 1 ? '' : 's'} ago';
    }
    return '${days ~/ 365} year${days ~/ 365 == 1 ? '' : 's'} ago';
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: grid.AppPalette.cardBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: grid.AppPalette.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _Stars(value: review.rating.toDouble(), size: 13),
              const SizedBox(width: 8),
              if (review.title != null)
                Expanded(
                  child: Text(
                    review.title!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                      color: grid.AppPalette.textPrimary,
                    ),
                  ),
                )
              else
                const Spacer(),
              if (onEdit != null)
                TextButton(
                  onPressed: onEdit,
                  style: TextButton.styleFrom(
                    foregroundColor: grid.AppPalette.textSecondary,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    minimumSize: const Size(0, 28),
                  ),
                  child: const Text('Edit'),
                ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${review.mine ? 'You' : review.authorName} · ${_when(review.updatedAt)}',
            style: TextStyle(fontSize: 11.5, color: grid.AppPalette.textFaint),
          ),
          if (review.body != null) ...[
            const SizedBox(height: 8),
            Text(
              review.body!,
              style: TextStyle(
                fontSize: 13,
                height: 1.45,
                color: grid.AppPalette.textPrimary,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// ─── dialogs ─────────────────────────────────────────────────────────────────

class _ReviewDraft {
  const _ReviewDraft({
    required this.rating,
    this.title,
    this.body,
    this.delete = false,
  });
  final int rating;
  final String? title;
  final String? body;
  final bool delete;
}

class _ReviewDialog extends StatefulWidget {
  const _ReviewDialog({required this.name, this.existing});
  final String name;
  final StoreReview? existing;

  @override
  State<_ReviewDialog> createState() => _ReviewDialogState();
}

class _ReviewDialogState extends State<_ReviewDialog> {
  late int _rating = widget.existing?.rating ?? 0;
  late final _title = TextEditingController(text: widget.existing?.title ?? '');
  late final _body = TextEditingController(text: widget.existing?.body ?? '');

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return _DialogCard(
      width: 460,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            widget.existing == null
                ? 'Rate ${widget.name}'
                : 'Your review of ${widget.name}',
            style: TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w600,
              color: grid.AppPalette.textPrimary,
            ),
          ),
          const SizedBox(height: 14),
          _Stars(
            key: const ValueKey('store-review-stars'),
            value: _rating.toDouble(),
            size: 30,
            onPick: (n) => setState(() => _rating = n),
          ),
          const SizedBox(height: 14),
          TextField(
            key: const ValueKey('store-review-title'),
            controller: _title,
            maxLength: 80,
            decoration: const InputDecoration(
              labelText: 'Title (optional)',
              counterText: '',
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            key: const ValueKey('store-review-body'),
            controller: _body,
            maxLength: 2000,
            minLines: 3,
            maxLines: 8,
            decoration: const InputDecoration(
              labelText: 'What was it like?',
              counterText: '',
              alignLabelWithHint: true,
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              if (widget.existing != null)
                TextButton(
                  key: const ValueKey('store-review-delete'),
                  onPressed: () =>
                      Navigator.of(context)
                          .pop(const _ReviewDraft(rating: 0, delete: true)),
                  style: TextButton.styleFrom(
                    foregroundColor: grid.AppPalette.warn,
                  ),
                  child: const Text('Delete review'),
                ),
              const Spacer(),
              TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('Cancel'),
              ),
              const SizedBox(width: 8),
              FilledButton(
                key: const ValueKey('store-review-post'),
                onPressed: _rating == 0
                    ? null
                    : () => Navigator.of(context).pop(
                        _ReviewDraft(
                          rating: _rating,
                          title: _title.text,
                          body: _body.text,
                        ),
                      ),
                child: Text(widget.existing == null ? 'Post' : 'Save'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ConfirmCard extends StatelessWidget {
  const _ConfirmCard({
    required this.title,
    required this.detail,
    required this.action,
  });
  final String title;
  final String detail;
  final String action;

  @override
  Widget build(BuildContext context) {
    return _DialogCard(
      width: 420,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            title,
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
              color: grid.AppPalette.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            detail,
            style: TextStyle(
              fontSize: 13,
              height: 1.4,
              color: grid.AppPalette.textSecondary,
            ),
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: const Text('Cancel'),
              ),
              const SizedBox(width: 8),
              FilledButton(
                key: const ValueKey('store-confirm'),
                onPressed: () => Navigator.of(context).pop(true),
                style: FilledButton.styleFrom(
                  backgroundColor: grid.AppPalette.dangerFill,
                ),
                child: Text(action),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _DialogCard extends StatelessWidget {
  const _DialogCard({required this.width, required this.child});
  final double width;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Material(
        color: grid.AppPalette.panelBg,
        borderRadius: BorderRadius.circular(16),
        clipBehavior: Clip.antiAlias,
        child: Container(
          width: width,
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: grid.AppPalette.divider),
          ),
          child: child,
        ),
      ),
    );
  }
}
