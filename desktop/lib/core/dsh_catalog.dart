/// Which domain-specific harnesses one machine has, or could install, as that
/// machine answered it (`dsh_list` in the CLI's backendSocket).
///
/// A harness is installed PER MACHINE — it is a clone under `~/.harness/dsh`
/// on the box the agent will run on, with that box's toolchain set up beside
/// it — so, exactly like [MachineEngines], the answer is asked of the machine
/// and rendered, never computed here. The catalog the daemon merges in (the
/// registry bundled into the CLI) is what lets the Create dialog offer Circuit
/// on a machine that has never heard of it and say "Harness will install".
library;

class DshEntry {
  const DshEntry({
    required this.id,
    required this.name,
    required this.engine,
    this.description,
    this.category,
    this.installed = false,
    this.viewer = false,
    this.tier = 0,
    this.kind = 'agent',
    this.author,
    this.repo,
    this.homepage,
    this.upstream,
    this.license,
    this.screenshots = const [],
    this.linked = false,
  });

  /// `owner/name` — the install directory on the machine and the wire id.
  final String id;

  /// The tile's name, as the manifest or the registry spells it.
  final String name;

  /// The base engine the harness runs on: what `agent_create` must be sent.
  final String engine;
  final String? description;

  /// The kind of thing it makes, in a word or two — the picker's second line.
  final String? category;
  final bool installed;

  /// Whether it ships a viewer, i.e. whether a web pane will open beside it.
  final bool viewer;
  final int tier;

  /// `agent` — a harness, one tile; `viewer` — a pane other packages point at
  /// with `viewer.use`, installed alongside them and never a tile (spec 1.1).
  final String kind;
  bool get isViewerPackage => kind == 'viewer';

  /// Who made it — "Autonomous" for everything under autonomous/ — beside the category on the tile.
  final String? author;

  /// The store's product page, from the registry: the package's repo, the
  /// project's homepage, the upstream it wraps, the wrapper's licence, pictures.
  final String? repo;
  final String? homepage;
  final String? upstream;
  final String? license;
  final List<String> screenshots;

  /// Installed as a link to a checkout (`--link`) rather than a clone: a
  /// developer's own working copy, which Remove would only unlink.
  final bool linked;

  static DshEntry? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final kind = raw['kind'] == 'viewer' ? 'viewer' : 'agent';
    final engine = kind == 'viewer' ? '' : raw['engine'];
    if (id is! String || !_validId(id)) return null;
    if (kind != 'viewer' && (engine is! String || engine.isEmpty || engine.length > 64)) return null;
    final name = raw['name'];
    final description = raw['description'];
    final category = raw['category'];
    final author = raw['author'];
    final tier = raw['tier'];
    final screenshots = raw['screenshots'];
    return DshEntry(
      id: id,
      repo: _httpUrl(raw['repo']),
      homepage: _httpUrl(raw['homepage']),
      upstream: _httpUrl(raw['upstream']),
      license: _short(raw['license'], 40),
      screenshots: screenshots is List
          ? screenshots.map(_httpUrl).whereType<String>().take(8).toList(growable: false)
          : const [],
      linked: raw['linked'] == true,
      name: name is String && name.trim().isNotEmpty
          ? name.trim().substring(0, name.trim().length.clamp(0, 40))
          : id.substring(id.indexOf('/') + 1),
      engine: engine is String ? engine : '',
      kind: kind,
      description: description is String && description.trim().isNotEmpty
          ? description.trim().substring(
              0,
              description.trim().length.clamp(0, 300),
            )
          : null,
      category: category is String && category.trim().isNotEmpty
          ? category.trim().substring(0, category.trim().length.clamp(0, 24))
          : null,
      author: author is String && author.trim().isNotEmpty
          ? author.trim().substring(0, author.trim().length.clamp(0, 80))
          : null,
      installed: raw['installed'] == true,
      viewer: raw['viewer'] == true,
      tier: tier is num && tier >= 0 && tier <= 9 ? tier.toInt() : 0,
    );
  }

  /// An https URL, or nothing: the page opens what the registry says, so it
  /// must never be a `file:` or `javascript:` link.
  static String? _httpUrl(Object? raw) {
    if (raw is! String) return null;
    final uri = Uri.tryParse(raw.trim());
    if (uri == null || !uri.hasAuthority || (uri.scheme != 'https' && uri.scheme != 'http')) return null;
    return raw.trim().length > 2048 ? null : raw.trim();
  }

  static String? _short(Object? raw, int max) => raw is String && raw.trim().isNotEmpty
      ? raw.trim().substring(0, raw.trim().length.clamp(0, max))
      : null;

  static bool _validId(String id) =>
      id.length <= 129 &&
      RegExp(r'^[a-z0-9][a-z0-9-]{0,63}/[a-z0-9][a-z0-9-]{0,63}$').hasMatch(id);
}

/// Where an install the user asked for stands, as the machine reports it
/// (`dsh_install_status` pushes: clone → setup → doctor → done, or failed).
class DshInstallProgress {
  const DshInstallProgress({
    required this.id,
    required this.phase,
    this.detail,
    this.line,
  });

  final String id;
  final String phase;
  final String? detail;

  /// The line the phase's command is on right now, as the machine narrates it
  /// (throttled there). What turns "Setting up…" for three minutes into
  /// "Installed 61 packages".
  final String? line;

  bool get done => phase == 'done';
  bool get failed => phase == 'failed';
  bool get inProgress => !done && !failed;

  /// A sentence for the dialog's status line.
  String get label => switch (phase) {
    'clone' => 'Fetching…',
    'setup' => 'Setting up the toolchain…',
    'doctor' => 'Checking the machine…',
    'done' => 'Installed',
    'failed' => detail?.isNotEmpty == true ? detail! : 'Install failed',
    _ => 'Installing…',
  };

  static DshInstallProgress? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final phase = raw['phase'];
    if (id is! String || id.isEmpty || phase is! String || phase.isEmpty) {
      return null;
    }
    final detail = raw['detail'];
    final line = raw['line'];
    return DshInstallProgress(
      id: id,
      phase: phase,
      detail: detail is String && detail.trim().isNotEmpty
          ? _clean(detail, 500)
          : null,
      line: line is String && line.trim().isNotEmpty ? _clean(line, 200) : null,
    );
  }

  static String _clean(String raw, int max) {
    final text = raw.replaceAll(RegExp(r'[\x00-\x1f\x7f]'), ' ').trim();
    return text.length > max ? text.substring(0, max) : text;
  }
}

/// One install as the dialog watches it: every phase the machine reported,
/// when each began, and the lines it printed on the way — the material for a
/// panel that says what is happening rather than that something is.
///
/// Kept beside [MachineDsh.installs] (the latest phase, which older callers
/// read) rather than replacing it.
class DshInstallRun {
  DshInstallRun(this.id, {DateTime? startedAt})
    : startedAt = startedAt ?? DateTime.now();

  final String id;
  final DateTime startedAt;

  /// Phases in the order they began, with when. `done`/`failed` close the run.
  final List<({String phase, DateTime at})> phases = [];

  /// What the phases printed, oldest first, bounded.
  final List<String> log = [];
  static const int maxLog = 40;

  String? line;
  String? detail;

  String get phase => phases.isEmpty ? 'clone' : phases.last.phase;
  bool get done => phase == 'done';
  bool get failed => phase == 'failed';
  bool get inProgress => !done && !failed;

  /// The doctor's verdict lines (`ok …`, `miss …`, `warn …`) seen so far.
  List<String> get checks => log
      .where((l) => RegExp(r'^(ok|miss|warn)\s').hasMatch(l))
      .toList(growable: false);

  /// How long [phase] took, once the next one began.
  Duration? took(String phase) {
    for (var i = 0; i < phases.length; i++) {
      if (phases[i].phase != phase) continue;
      if (i + 1 < phases.length) {
        return phases[i + 1].at.difference(phases[i].at);
      }
      return null;
    }
    return null;
  }

  bool reached(String phase) => phases.any((p) => p.phase == phase);

  void apply(DshInstallProgress progress, {DateTime? now}) {
    final at = now ?? DateTime.now();
    if (phases.isEmpty || phases.last.phase != progress.phase) {
      phases.add((phase: progress.phase, at: at));
    }
    if (progress.detail != null) detail = progress.detail;
    if (progress.line != null && progress.line != line) {
      line = progress.line;
      log.add(progress.line!);
      if (log.length > maxLog) log.removeAt(0);
    }
  }
}

/// One machine's answers, with the same "still asking" versus "asked, and it
/// has nothing" distinction [MachineEngines] keeps — a tile must not read as
/// "not installed" on the strength of a request that has not come back.
class MachineDsh {
  MachineDsh();

  final Map<String, DshEntry> byId = {};

  /// True once `dsh_list` has answered at least once. Never reset by a
  /// refresh, so the rows already on screen stay put while a new answer lands.
  bool loaded = false;

  /// A request is in flight. Held so a dialog opening twice does not start two.
  Future<void>? inFlight;

  /// Set when the machine could not answer — an older CLI that does not know
  /// the request, or a transport failure. The dialog still offers the harnesses
  /// this build ships a face for; the machine decides at create time.
  String? error;

  /// Installs the user asked for, by harness id, at their latest reported phase.
  final Map<String, DshInstallProgress> installs = {};

  /// The same installs with their history — see [DshInstallRun].
  final Map<String, DshInstallRun> runs = {};

  /// Record a progress push against both views. A push for a run nobody here
  /// started (another window asked) opens one, so it can still be watched.
  void applyInstall(DshInstallProgress progress, {DateTime? now}) {
    installs[progress.id] = progress;
    var run = runs[progress.id];
    // A fresh push after a closed run is a new attempt.
    if (run == null || run.done || run.failed) {
      run = DshInstallRun(progress.id, startedAt: now);
      runs[progress.id] = run;
    }
    run.apply(progress, now: now);
  }

  DshEntry? operator [](String id) => byId[id];

  /// Every harness the machine named, installed or not, in the order it gave.
  List<DshEntry> get entries => byId.values.toList(growable: false);

  void replace(Iterable<DshEntry> found) {
    byId
      ..clear()
      ..addEntries(found.map((entry) => MapEntry(entry.id, entry)));
    loaded = true;
    error = null;
  }
}
