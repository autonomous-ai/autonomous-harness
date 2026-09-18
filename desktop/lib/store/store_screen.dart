import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../analytics/analytics.dart';
import '../core/dsh_catalog.dart';
import '../core/models.dart' show ConnectionStatus;
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
import 'store_showcase.dart';
import 'store_viewers.dart';

/// The Harness Store, the content of its tab: every harness the registry
/// knows and every built-in engine, as a shelf of cards; one becomes its page
/// — what it is, whose it is, where it is installed, what people think of it —
/// with Get, Open and Remove. A tab, not a screen over the window, so the
/// strip stays where it is and browsing never blocks switching.
///
/// The catalogue and installation state come from this computer's daemon.
/// Browsing, Get, Open and Remove all refer to this computer; remote machines
/// do not contribute packages or installation state to the Store.
/// Ratings and reviews come from the control plane through
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

class _Viewers extends _Shelf {
  const _Viewers();
}

/// The shelves drawn as a plain listing: everything but Discover's front page
/// and the Viewers page, which have views of their own.
sealed class _Listed extends _Shelf {
  const _Listed();
}

class _All extends _Listed {
  const _All();
}

class _Search extends _Listed {
  const _Search(this.query);
  final String query;
}

class _Collection extends _Listed {
  const _Collection(this.collection);
  final StoreCollection collection;
}

class _Category extends _Listed {
  const _Category(this.name);
  final String name;
}

/// Where a person was in the store, kept per window (the app has one store
/// tab). Only the visible tab is built, so switching away disposed the store's
/// state: coming back reset it to Discover, with the search and the open
/// product page gone. A tab should keep its place, as a browser tab does.
class _StorePlace {
  _Shelf shelf = const _Discover();
  String? selected;
  String query = '';
}

final _storePlaces = Expando<_StorePlace>('store place');

class _StoreTabState extends State<StoreTab> {
  late final StoreController _store = StoreController(
    widget.api ?? ApiStoreApi(widget.notifier.api),
  );
  late final _StorePlace _place = _storePlaces[widget.notifier] ??=
      _StorePlace();
  late _Shelf _shelf = widget.initialHarness == null
      ? _place.shelf
      : const _Discover();
  late String? _selected = widget.initialHarness ?? _place.selected;
  late final _search = TextEditingController(
    text: widget.initialHarness == null ? _place.query : '',
  );
  Timer? _catalogRefresh;

  void _remember() {
    _place
      ..shelf = _shelf
      ..selected = _selected
      ..query = _search.text;
  }

  @override
  void setState(VoidCallback fn) {
    super.setState(fn);
    _remember();
  }

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
      // Refresh installs made from a local terminal while the Store was closed.
      final local = widget.notifier.localMachineState;
      if (local != null) _ask(local);
      widget.notifier.addListener(_onAppChanged);
      // A Store left open picks up new publications; engines do not need reprobes.
      // The daemon caches catalog HTTP requests for five minutes.
      _catalogRefresh = Timer.periodic(const Duration(minutes: 1), (_) {
        final local = widget.notifier.localMachineState;
        if (local?.connectionStatus == ConnectionStatus.connected) {
          unawaited(
            widget.notifier.probeDsh(local!.machine.machineId, force: true),
          );
        }
      });
    });
  }

  /// Machines asked since they last connected.
  ///
  /// A store tab restored when the app launches is built before any machine
  /// has connected: the first ask fails, and nothing asked again — the shelf
  /// showed the three engines, each offering Get, over a machine with 21
  /// harnesses installed. So a machine is asked again each time it connects.
  final _askedWhileConnected = <String>{};

  void _ask(MachineState machine) {
    final id = machine.machine.machineId;
    if (machine.connectionStatus == ConnectionStatus.connected) {
      _askedWhileConnected.add(id);
    }
    unawaited(widget.notifier.probeDsh(id, force: true));
    // The engine rows read the same probe the New Harness dialog does; a
    // machine that has never been asked would show Claude Code as absent.
    unawaited(widget.notifier.probeEngines(id, force: true));
  }

  void _onAppChanged() {
    final connecting = <MachineState>[];
    for (final machine in [?widget.notifier.localMachineState]) {
      final id = machine.machine.machineId;
      if (machine.connectionStatus != ConnectionStatus.connected) {
        _askedWhileConnected.remove(id);
      } else if (!_askedWhileConnected.contains(id)) {
        connecting.add(machine);
      }
    }
    if (connecting.isEmpty) return;
    // Out of the notification: asking notifies the same listeners again.
    scheduleMicrotask(() {
      if (!mounted) return;
      for (final machine in connecting) {
        if (machine.connectionStatus == ConnectionStatus.connected &&
            identical(machine, widget.notifier.localMachineState) &&
            !_askedWhileConnected.contains(machine.machine.machineId)) {
          _ask(machine);
        }
      }
    });
  }

  @override
  void dispose() {
    _catalogRefresh?.cancel();
    widget.notifier.removeListener(_onAppChanged);
    _search.dispose();
    _store.dispose();
    super.dispose();
  }

  /// The local daemon's catalog carries the registry, plus one row per
  /// built-in engine, because a person looking for "Claude Code" in a store
  /// should find it beside Marp, not learn that it is a different kind of thing.
  Map<String, DshEntry> get _catalog {
    final rows = <String, DshEntry>{};
    final local = widget.notifier.localMachineState;
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
        installed: _installedOnMachine(local, identity.id),
      );
    }
    for (final entry in local?.dsh.entries ?? const <DshEntry>[]) {
      rows.putIfAbsent(entry.id, () => entry);
    }
    return rows;
  }

  /// Store installation facts are local, including shared viewer packages.
  List<MachineState> _installedOn(String id) => [
    for (final state in [?widget.notifier.localMachineState])
      if (_installedOnMachine(state, id)) state,
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
      _Viewers() => all.where((e) => e.isViewerPackage).toList(),
      _Collection(:final collection) =>
        all.where((e) => !e.isViewerPackage && collection.includes(e)).toList(),
      _Category(:final name) =>
        all
            .where((e) => !e.isViewerPackage && storeCategoryFor(e) == name)
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
    final local = widget.notifier.localMachineState;
    if (local == null ||
        !_installedOnMachine(local, entry.id) ||
        local.dsh[entry.id]?.hasUpdate == true) {
      _openPage(entry.id);
      return;
    }
    unawaited(
      _openStoreAgent(context, widget.notifier, entry, local.machine.machineId),
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
                              onBack: () => setState(() => _selected = null),
                            )
                          : _shelf is _Viewers
                          ? StoreViewers(
                              viewers: _shelved(const _Viewers()),
                              agents:
                                  widget
                                      .notifier
                                      .localMachineState
                                      ?.dsh
                                      .entries ??
                                  const [],
                              installedOn: (id) => _installedOn(id)
                                  .map((machine) => machine.machine.displayName)
                                  .toList(),
                              onOpenAgent: _openPage,
                              loaded:
                                  widget
                                      .notifier
                                      .localMachineState
                                      ?.dsh
                                      .loaded ??
                                  false,
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
                              shelf: _shelf as _Listed,
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
      child: Column(
        children: [
          Expanded(
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 22),
              children: [
                TextField(
                  key: const ValueKey('store-search'),
                  controller: search,
                  onChanged: onSearch,
                  style: TextStyle(
                    fontSize: 13,
                    color: grid.AppPalette.textPrimary,
                  ),
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
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 10, 18, 16),
            child: Align(
              alignment: Alignment.centerLeft,
              child: AppIconButton(
                key: const ValueKey('store-viewers-button'),
                icon: LucideIcons.panelsTopLeft300,
                size: 17,
                color: shelf is _Viewers
                    ? grid.AppPalette.textPrimary
                    : grid.AppPalette.textFaint,
                tooltip: 'Viewers',
                onPressed: () => onSelect(const _Viewers()),
              ),
            ),
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

  final _Listed shelf;
  final List<DshEntry> entries;
  final StoreController store;
  final List<MachineState> Function(String id) installedOn;
  final bool loaded;
  final ValueChanged<String> onOpen;
  final ValueChanged<DshEntry> onAction;

  String get _title => switch (shelf) {
    _All() => 'All harnesses',
    _Search() => 'Search results',
    _Collection(:final collection) => collection.title,
    _Category(:final name) => name,
  };

  String get _subtitle => switch (shelf) {
    _All() => 'Find something you have always wanted to make.',
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
                      : 'Asking this computer…',
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

bool _installedOnMachine(MachineState? machine, String id) => isHarnessId(id)
    ? machine?.dsh[id]?.installed == true
    : machine?.engines[id]?.installed == true;

bool _canGetOnMachine(MachineState machine, DshEntry entry) {
  if (machine.needsLink || machine.nodeOnline == false) return false;
  if (entry.isEngine) {
    return machine.engines.loaded &&
        machine.engines[entry.id]?.installable == true;
  }
  return machine.dsh.loaded &&
      machine.dsh[entry.id] != null &&
      machine.dsh.runs[entry.id]?.inProgress != true;
}

Future<void> _openStoreAgent(
  BuildContext context,
  AppNotifier notifier,
  DshEntry entry,
  String machineId, {
  String? prompt,
}) async {
  final origin = notifier.activeSwarmId;
  notifier.newSwarm(draft: true);
  final target = notifier.activeSwarmId;
  final result = await showNewAgentDialog(
    context,
    notifier,
    machineId,
    source: 'store',
    initialEngine: entry.id,
    initialPrompt: prompt,
    swarmId: target,
  );
  if (result != null) return;
  // Dismissed: back to the store page. A tab made for this is a draft and cancelling it returns there;
  // but newSwarm hands over an empty New Tab the window already had instead of making a second one,
  // and that tab is the person's own — it stays, and the store is selected again.
  if (!notifier.cancelSwarmDraft(target) &&
      notifier.activeSwarmId == target &&
      target != origin) {
    notifier.selectSwarm(origin);
  }
}

class _ProductPage extends StatefulWidget {
  const _ProductPage({
    super.key,
    required this.entry,
    required this.notifier,
    required this.store,
    required this.onBack,
  });

  final DshEntry entry;
  final AppNotifier notifier;
  final StoreController store;
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
    final local = widget.notifier.localMachineState;
    if (local == null ||
        local.machine.machineId != machineId ||
        !_canGetOnMachine(local, widget.entry)) {
      return;
    }
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

  Future<void> _update(String machineId) async {
    final local = widget.notifier.localMachineState;
    if (local == null ||
        local.machine.machineId != machineId ||
        local.dsh[widget.entry.id]?.hasUpdate != true ||
        !_busy.add(machineId)) {
      return;
    }
    setState(() {});
    final failure = await widget.notifier.updateDsh(machineId, widget.entry.id);
    _busy.remove(machineId);
    if (mounted) setState(() {});
    if (failure != null) _say(failure);
  }

  Future<void> _remove(String machineId, String machineName) async {
    if (widget.notifier.localMachineState?.machine.machineId != machineId) {
      return;
    }
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
    // No second Remove can be in flight: the dialog above is modal, and while
    // one runs the row shows progress instead of the button.
    _busy.add(machineId);
    setState(() {});
    final failure = await widget.notifier.removeDsh(machineId, widget.entry.id);
    _busy.remove(machineId);
    if (mounted) setState(() {});
    if (failure != null) _say(failure);
  }

  /// Open (or Get) from the store: the harness needs a tab of its own, since
  /// a pane never lands in the store tab. A draft tab is opened for it and
  /// abandoned — back to the store — if the dialog is dismissed. [prompt] is
  /// an example's, and becomes the new harness's first message.
  Future<void> _open(String machineId, {String? prompt}) async {
    if (widget.notifier.localMachineState?.machine.machineId != machineId) {
      return;
    }
    await _openStoreAgent(
      context,
      widget.notifier,
      widget.entry,
      machineId,
      prompt: prompt,
    );
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

  /// Where the reviews start, so the rating under the name can take a person there.
  final _reviewsKey = GlobalKey();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final entry = widget.entry;
    final identity = engineIdentity(entry.id, displayName: entry.name);
    final author = entry.author ?? identity.creator;
    final category = entry.category ?? identity.category;
    final rating = widget.store.ratingOf(_key);
    final page = widget.store.reviews[_key];
    final local = widget.notifier.localMachineState;
    final localInstalled = _installedOnMachine(local, entry.id);
    final hasUpdate = local?.dsh[entry.id]?.hasUpdate == true;
    final base = entry.engine.isNotEmpty
        ? entry.engine
        : (knownHarnessBase[entry.id] ?? '');
    final baseLabel = base.isEmpty ? null : engineIdentity(base).label;
    final description = entry.description ?? identity.blurb;
    final installing = local?.dsh.runs[entry.id]?.inProgress == true;
    final failed = local?.dsh.runs[entry.id]?.failed == true;
    final busy = local != null && _busy.contains(local.machine.machineId);
    // New Harness installs a harness the machine lacks before it creates, so
    // an example can be tried from here whether or not Get was pressed.
    final canTry =
        !entry.isViewerPackage &&
        local != null &&
        !busy &&
        !installing &&
        (localInstalled || _canGetOnMachine(local, entry));
    // A package that has not published its own examples yet still leads with
    // prompts — the editorial ones — so every page reads the same way.
    final examples = entry.examples.isNotEmpty
        ? entry.examples
        : [
            for (final prompt
                in storeStories[entry.id]?.prompts ?? const <String>[])
              StoreExample(prompt: prompt),
          ];
    final screenshots = entry.examples.isEmpty
        ? entry.screenshots
        : const <String>[];
    // A viewer package is never opened on its own: once it is here there is
    // nothing more to press, and Remove sits in the line beneath.
    final showAction =
        local != null &&
        (hasUpdate || !(entry.isViewerPackage && localInstalled));

    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 820;
        final side = wide ? 56.0 : 24.0;
        return SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(side, 12, side, 140),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  key: const ValueKey('store-back'),
                  onPressed: widget.onBack,
                  icon: const Icon(LucideIcons.arrowLeft300, size: 15),
                  label: const Text('Back'),
                  style: TextButton.styleFrom(
                    foregroundColor: grid.AppPalette.textSecondary,
                  ),
                ),
              ),
              // The name in its own light: a soft glow of the harness's colour behind the hero.
              DecoratedBox(
                decoration: BoxDecoration(
                  gradient: RadialGradient(
                    center: const Alignment(0, -0.12),
                    radius: wide ? 0.44 : 0.5,
                    colors: [
                      identity.color.withValues(alpha: 0.16),
                      identity.color.withValues(alpha: 0),
                    ],
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SizedBox(height: wide ? 44 : 20),
                    Center(
                      child: EngineMark(
                        engine: entry.id,
                        displayName: entry.name,
                        size: wide ? 96 : 72,
                      ),
                    ),
                    const SizedBox(height: 26),
                    Text(
                      entry.name,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: wide ? 64 : 42,
                        height: 1.02,
                        fontWeight: FontWeight.w700,
                        letterSpacing: wide ? -2.2 : -1.2,
                        color: grid.AppPalette.textPrimary,
                      ),
                    ),
                    if (description != null) ...[
                      const SizedBox(height: 18),
                      Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 640),
                          child: Text(
                            description,
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontSize: wide ? 19 : 16,
                              height: 1.45,
                              color: grid.AppPalette.textSecondary,
                            ),
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: 22),
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
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 13,
                        color: grid.AppPalette.textFaint,
                      ),
                    ),
                    const SizedBox(height: 12),
                    Wrap(
                      alignment: WrapAlignment.center,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      spacing: 20,
                      runSpacing: 8,
                      children: [
                        if (!rating.isEmpty)
                          _QuietLink(
                            key: const ValueKey('store-rating-link'),
                            onTap: () {
                              final target = _reviewsKey.currentContext;
                              if (target != null) {
                                unawaited(
                                  Scrollable.ensureVisible(
                                    target,
                                    duration: const Duration(milliseconds: 600),
                                    curve: Curves.easeInOutCubic,
                                  ),
                                );
                              }
                            },
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                _Stars(value: rating.average, size: 14),
                                const SizedBox(width: 6),
                                Text(
                                  '${rating.average.toStringAsFixed(1)} · ${rating.count} rating${rating.count == 1 ? '' : 's'}',
                                ),
                              ],
                            ),
                          ),
                        if (entry.homepage != null)
                          _QuietLink(label: 'Website', url: entry.homepage!),
                        if (entry.upstream != null)
                          _QuietLink(label: 'Source', url: entry.upstream!),
                        if (entry.repo != null)
                          _QuietLink(label: 'Package', url: entry.repo!),
                        if (entry.license != null)
                          _QuietLink(label: '${entry.license} licence'),
                      ],
                    ),
                    const SizedBox(height: 34),
                    if (showAction)
                      Center(
                        child: FilledButton(
                          key: const ValueKey('store-primary-action'),
                          onPressed:
                              busy ||
                                  installing ||
                                  (!localInstalled &&
                                      !_canGetOnMachine(local, entry))
                              ? null
                              : () => hasUpdate
                                    ? _update(local.machine.machineId)
                                    : localInstalled
                                    ? _open(local.machine.machineId)
                                    : _get(local.machine.machineId),
                          style: FilledButton.styleFrom(
                            backgroundColor: grid.AppPalette.textPrimary,
                            foregroundColor: grid.AppPalette.windowBg,
                            minimumSize: const Size(148, 50),
                            padding: const EdgeInsets.symmetric(horizontal: 30),
                            textStyle: TextStyle(
                              fontFamily: grid.AppFont.sans,
                              fontFamilyFallback: grid.AppFont.sansFallback,
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                            ),
                            shape: const StadiumBorder(),
                          ),
                          child: Text(
                            installing || busy
                                ? 'Working…'
                                : hasUpdate
                                ? 'Update'
                                : localInstalled
                                ? 'Open'
                                : failed
                                ? 'Try again'
                                : 'Get',
                          ),
                        ),
                      ),
                    if (hasUpdate) ...[
                      const SizedBox(height: 10),
                      Text(
                        'Your projects and files are kept.',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 12.5,
                          color: grid.AppPalette.textSecondary,
                        ),
                      ),
                      if (!entry.isViewerPackage)
                        TextButton(
                          key: const ValueKey('store-open-current'),
                          onPressed: busy || installing
                              ? null
                              : () => _open(local!.machine.machineId),
                          child: const Text('Open'),
                        ),
                    ],
                    const SizedBox(height: 14),
                    Center(
                      child: local == null
                          ? Text(
                              'Connecting to this computer…',
                              style: TextStyle(
                                fontSize: 12.5,
                                color: grid.AppPalette.textFaint,
                              ),
                            )
                          : _InstallLine(
                              key: ValueKey(
                                'store-machine:${local.machine.machineId}',
                              ),
                              state: local,
                              entry: entry,
                              busy: busy,
                              onRemove: () => _remove(
                                local.machine.machineId,
                                local.machine.displayName,
                              ),
                            ),
                    ),
                    const SizedBox(height: 24),
                  ],
                ),
              ),
              if (examples.isNotEmpty) ...[
                SizedBox(height: wide ? 136 : 88),
                StoreExampleFlow(
                  entry: entry,
                  examples: examples,
                  onTry: canTry
                      ? (prompt) =>
                            _open(local.machine.machineId, prompt: prompt)
                      : null,
                ),
              ],
              for (final (i, url) in screenshots.indexed) ...[
                SizedBox(height: i == 0 ? (wide ? 120 : 72) : 48),
                Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 1120),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(wide ? 28 : 18),
                      child: Image.network(
                        url,
                        fit: BoxFit.cover,
                        errorBuilder: (_, _, _) => const SizedBox.shrink(),
                      ),
                    ),
                  ),
                ),
              ],
              if (page != null || !rating.isEmpty) ...[
                SizedBox(height: wide ? 160 : 96),
                Center(
                  child: ConstrainedBox(
                    key: _reviewsKey,
                    constraints: const BoxConstraints(maxWidth: 720),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          'Ratings and reviews',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 28,
                            fontWeight: FontWeight.w700,
                            letterSpacing: -0.6,
                            color: grid.AppPalette.textPrimary,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Center(
                          child: TextButton(
                            key: const ValueKey('store-write-review'),
                            onPressed: _review,
                            child: Text(
                              page?.mine == null
                                  ? 'Write a review'
                                  : 'Edit your review',
                            ),
                          ),
                        ),
                        const SizedBox(height: 20),
                        if (!rating.isEmpty) _RatingSummary(rating: rating),
                        if (widget.store.reviewsError[_key] != null) ...[
                          const SizedBox(height: 8),
                          Text(
                            'Reviews are unavailable right now.',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontSize: 12,
                              color: grid.AppPalette.textSecondary,
                            ),
                          ),
                        ],
                        const SizedBox(height: 16),
                        if (page != null && page.reviews.isEmpty)
                          Text(
                            'No reviews yet. Be the first.',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontSize: 13,
                              color: grid.AppPalette.textFaint,
                            ),
                          ),
                        for (final review
                            in page?.reviews ?? const <StoreReview>[])
                          Padding(
                            padding: const EdgeInsets.only(bottom: 10),
                            child: _ReviewCard(
                              key: ValueKey('store-review:${review.id}'),
                              review: review,
                              onEdit: review.mine ? _review : null,
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

/// The one line under the page's action: where this is, and what it is doing there — asking,
/// installing, installed, failed — with Remove once there is something to remove.
class _InstallLine extends StatelessWidget {
  const _InstallLine({
    super.key,
    required this.state,
    required this.entry,
    required this.busy,
    required this.onRemove,
  });

  final MachineState state;
  final DshEntry entry;
  final bool busy;
  final VoidCallback onRemove;

  String _engineStatus() {
    final installed = state.engines[entry.id]?.installed == true;
    if (!installed && state.needsLink) return 'Link required';
    if (!installed && state.nodeOnline == false) return 'Offline';
    if (!state.engines.loaded) return 'Asking…';
    return installed ? 'Installed' : 'Not installed';
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final row = state.dsh[entry.id];
    final run = state.dsh.runs[entry.id];
    final installing = run != null && run.inProgress;
    final installed = !entry.isEngine && row?.installed == true;
    final String status;
    if (entry.isEngine) {
      status = _engineStatus();
    } else if (installing) {
      status = switch (run.phase) {
        'clone' => 'Fetching…',
        'setup' => 'Setting up the toolchain…',
        'doctor' => 'Checking…',
        _ => 'Installing…',
      };
    } else if (run != null && run.failed) {
      status =
          run.log.where((line) => line.startsWith('miss')).lastOrNull ??
          (installed ? 'Update failed' : 'Install failed');
    } else if (installed) {
      status = row?.linked == true
          ? 'Installed · linked to a checkout'
          : row?.hasUpdate == true
          ? 'Update available'
          : 'Installed';
    } else if (state.needsLink) {
      // Why a machine cannot take this package right now, when it cannot. An
      // offline or unlinked machine answers nothing, so without these the line
      // said "Asking…" forever; a machine whose CLI predates the package lists
      // no row for it, and a Get there would only fail.
      status = 'Link required';
    } else if (state.nodeOnline == false) {
      status = 'Offline';
    } else if (state.dsh.loaded && state.dsh.error == null && row == null) {
      status = 'Update Harness CLI on this machine to get it';
    } else if (!state.dsh.loaded) {
      // `dsh_list` refused by a CLI that predates it arrives as the bare wire
      // code; the line says what to do about it instead.
      status = switch (state.dsh.error) {
        null => 'Asking…',
        'UNSUPPORTED' || 'UNSUPPORTED_ON_REMOTE' =>
          'Update the harness CLI on this machine to install harnesses',
        final error => error,
      };
    } else {
      status = 'Not installed';
    }
    final faint = TextStyle(fontSize: 12.5, color: grid.AppPalette.textFaint);
    return Wrap(
      alignment: WrapAlignment.center,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 8,
      runSpacing: 4,
      children: [
        if (installing || busy)
          const SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 1.6),
          ),
        Text('${state.machine.displayName} · this computer', style: faint),
        Text('·', style: faint),
        Text(
          status,
          style: TextStyle(
            fontSize: 12.5,
            color: run?.failed == true
                ? grid.AppPalette.warn
                : grid.AppPalette.textSecondary,
          ),
        ),
        if (installed && row?.installedCommit != null)
          Tooltip(
            message: row?.availableCommit == null
                ? 'Installed version: ${row!.installedCommit}'
                : 'Installed: ${row!.installedCommit}\nAvailable: ${row.availableCommit}',
            child: Text(row.installedCommit!.substring(0, 8), style: faint),
          ),
        if (installed && !installing && !busy) ...[
          Text('·', style: faint),
          _QuietLink(
            key: ValueKey('store-remove:${state.machine.machineId}'),
            label: 'Remove',
            onTap: onRemove,
          ),
        ],
      ],
    );
  }
}

/// A link that stays out of the way: secondary text, brighter under the pointer, an arrow when it
/// leaves the app. Without a destination it is plain text (the licence).
class _QuietLink extends StatefulWidget {
  const _QuietLink({super.key, this.label, this.url, this.onTap, this.child})
    : assert(label != null || child != null);

  final String? label;
  final String? url;
  final VoidCallback? onTap;
  final Widget? child;

  @override
  State<_QuietLink> createState() => _QuietLinkState();
}

class _QuietLinkState extends State<_QuietLink> {
  var _hovering = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final url = widget.url;
    final VoidCallback? tap = url != null
        ? () => unawaited(
            launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
          )
        : widget.onTap;
    final color = tap == null
        ? grid.AppPalette.textFaint
        : _hovering
        ? grid.AppPalette.textPrimary
        : grid.AppPalette.textSecondary;
    final content = DefaultTextStyle.merge(
      style: TextStyle(fontSize: 13, color: color),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          widget.child ?? Text(widget.label!),
          if (url != null) ...[
            const SizedBox(width: 3),
            Icon(LucideIcons.arrowUpRight300, size: 13, color: color),
          ],
        ],
      ),
    );
    if (tap == null) return content;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: tap,
        child: content,
      ),
    );
  }
}

/// Drawn only for a rating somebody has given.
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
              rating.average.toStringAsFixed(1),
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
