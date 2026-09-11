/// What OpenCode has spent on this computer, read out of its own database.
///
/// The odd one of the three. OpenCode keeps no transcript to walk: it writes a
/// SQLite database at `$XDG_DATA_HOME/opencode/opencode.db` and maintains
/// per-session token and cost totals inside it. So there is no parsing here at
/// all — one query, one row per session — and no pricing table either, because
/// **OpenCode records the cost itself** and a figure the provider computed beats
/// one we inferred from a model name.
///
/// ⚠️ **A zero cost from OpenCode is a measurement, not a silence.** Every
/// session run against a Grid records `cost = 0.0`, because Grid inference is
/// free (grid ADR 0039 D-g). That must not read the same as Claude's unpriced
/// models, which is why `LedgerEntry.costUsd` is nullable and this scanner is
/// the only one that ever fills it in.
library;

import 'dart:convert';
import 'dart:io';

import 'package:sqlite3/sqlite3.dart';

import 'ledger_scanner.dart';
import 'ledger_types.dart';

class OpenCodeLedgerScanner implements LedgerScanner {
  OpenCodeLedgerScanner({
    String? dataDirectory,
    Map<String, String>? environment,
  }) : _dataDirectory = dataDirectory ?? _resolveDataDirectory(environment);

  final String? _dataDirectory;

  @override
  LedgerProvider get provider => LedgerProvider.opencode;

  /// Where OpenCode keeps its data — XDG first, as OpenCode itself resolves it.
  static String? _resolveDataDirectory([Map<String, String>? environment]) {
    final env = environment ?? Platform.environment;
    final xdg = env['XDG_DATA_HOME']?.trim();
    if (xdg != null && xdg.isNotEmpty) return '$xdg/opencode';
    final home = homeDirectory(env);
    return home == null ? null : '$home/.local/share/opencode';
  }

  @override
  Future<LedgerScanResult> scan(Map<String, ScannedSource> previous) async {
    final directory = _dataDirectory;
    if (directory == null) {
      return const LedgerScanResult.unavailable(
        'No home directory to read the OpenCode database from',
      );
    }
    final databases = await _listDatabases(directory);
    if (databases.isEmpty) {
      return const LedgerScanResult.unavailable(
        'No OpenCode database on this computer',
      );
    }

    final sources = <ScannedSource>[];
    for (final file in databases) {
      final FileStat stat;
      try {
        stat = await file.stat();
      } on FileSystemException {
        continue;
      }
      final cached = previous[file.path];
      if (cached != null && cached.matches(stat)) {
        sources.add(cached);
        continue;
      }
      final List<LedgerEntry> entries;
      try {
        entries = _read(file.path);
      } on SqliteException catch (error) {
        // One unreadable database must not hide the others, but a machine whose
        // only database is locked or corrupt has to say so rather than report an
        // empty ledger as though nothing had been spent.
        if (databases.length == 1) {
          return LedgerScanResult.unavailable(
            'Could not read the OpenCode database: ${error.message}',
          );
        }
        continue;
      }
      sources.add(
        ScannedSource(
          path: file.path,
          mtimeMs: stat.modified.millisecondsSinceEpoch,
          size: stat.size,
          entries: entries,
        ),
      );
    }
    return LedgerScanResult(sources: sources);
  }

  /// `opencode.db` and its siblings, canonical one first.
  ///
  /// The canonical database is the live one and must claim a duplicated session
  /// ahead of a stale copy beside it; remaining ties go in path order so
  /// ownership is the same on every rescan.
  Future<List<File>> _listDatabases(String directory) async {
    final dir = Directory(directory);
    if (!await dir.exists()) return const [];
    final pattern = RegExp(r'^opencode(?:-[A-Za-z0-9_.-]+)?\.db$');
    final files = <File>[];
    try {
      await for (final entity in dir.list(followLinks: false)) {
        if (entity is! File) continue;
        if (pattern.hasMatch(entity.uri.pathSegments.last)) files.add(entity);
      }
    } on FileSystemException {
      return const [];
    }
    files.sort((a, b) {
      final aRank = a.uri.pathSegments.last == 'opencode.db' ? 0 : 1;
      final bRank = b.uri.pathSegments.last == 'opencode.db' ? 0 : 1;
      if (aRank != bRank) return aRank - bRank;
      return a.path.compareTo(b.path);
    });
    return files;
  }

  List<LedgerEntry> _read(String path) {
    // Read-only, so a scan can never write to a database the CLI owns — and
    // opening a live WAL database this way is fine, which is the case that
    // matters since OpenCode may be running while this scan happens.
    final db = sqlite3.open(path, mode: OpenMode.readOnly);
    try {
      if (!_hasTable(db, 'session')) return const [];
      final columns = _columns(db, 'session');
      // Newer OpenCode keeps per-session totals. One aggregate row per session
      // is both cheaper and more accurate than re-adding every message blob.
      const required = [
        'cost',
        'tokens_input',
        'tokens_output',
        'tokens_reasoning',
        'tokens_cache_read',
      ];
      if (!required.every(columns.contains)) return const [];
      final hasCacheWrite = columns.contains('tokens_cache_write');
      final hasModel = columns.contains('model');

      final rows = db.select(
        'SELECT id, directory, time_created, cost, '
        'tokens_input, tokens_output, tokens_reasoning, tokens_cache_read'
        '${hasCacheWrite ? ', tokens_cache_write' : ''}'
        '${hasModel ? ', model' : ''} '
        'FROM session '
        'WHERE tokens_input + tokens_output + tokens_reasoning + tokens_cache_read > 0 '
        'ORDER BY time_created, id',
      );

      return [
        for (final row in rows)
          ?_entry(row, hasCacheWrite: hasCacheWrite, hasModel: hasModel),
      ];
    } finally {
      db.dispose();
    }
  }

  LedgerEntry? _entry(
    Row row, {
    required bool hasCacheWrite,
    required bool hasModel,
  }) {
    final id = row['id'];
    if (id is! String) return null;
    final created = row['time_created'];
    if (created is! int) return null;

    return LedgerEntry(
      provider: LedgerProvider.opencode,
      sessionId: id,
      // Epoch MILLISECONDS, unlike the seconds most SQLite schemas store — read
      // off a live database rather than assumed.
      timestamp: DateTime.fromMillisecondsSinceEpoch(created),
      totals: UsageTotals(
        // `tokens_input` is a peer of `tokens_cache_read` here, as it is for
        // Claude, so no subtraction — see `UsageTotals.freshInput`.
        freshInput: _int(row['tokens_input']),
        // Reasoning folded into output to match the shared bucket's meaning; it
        // is billed at the output rate, and reported separately as a subset.
        output: _int(row['tokens_output']) + _int(row['tokens_reasoning']),
        reasoning: _int(row['tokens_reasoning']),
        cacheRead: _int(row['tokens_cache_read']),
        // OpenCode reports one cache-write figure and no TTL split, so it lands
        // on the 5m bucket rather than being guessed at as long-lived.
        cacheWrite5m: hasCacheWrite ? _int(row['tokens_cache_write']) : 0,
      ),
      model: hasModel ? _modelName(row['model']) : null,
      directory: row['directory'] as String?,
      costUsd: (row['cost'] as num?)?.toDouble(),
      // The session id is already unique per database, and the canonical-first
      // ordering above means a stale sibling copy of the same session is dropped
      // rather than counted twice.
      dedupeKey: 'opencode:$id',
    );
  }

  /// The model id out of OpenCode's `model` column.
  ///
  /// ⚠️ **That column holds JSON, not a name** — `{"id":"...","providerID":"..."}`
  /// — which is a real difference from Orca, whose query treats it as a plain
  /// string. Read off a live database. The plain-string form is still accepted
  /// because older schemas wrote one.
  static String? _modelName(Object? value) {
    if (value is! String || value.isEmpty) return null;
    if (!value.startsWith('{')) return value;
    try {
      final decoded = jsonDecode(value);
      if (decoded is Map<String, Object?>) {
        final id = decoded['id'];
        if (id is String && id.isNotEmpty) {
          final provider = decoded['providerID'];
          // Qualified, because the same model id means different things (and
          // different prices) behind two providers — `autonomous-ai` is a Grid,
          // and free.
          return provider is String && provider.isNotEmpty
              ? '$provider/$id'
              : id;
        }
      }
    } on FormatException {
      // A column that is neither JSON nor a bare name tells us nothing; an
      // unnamed model is already an ordinary state here, since OpenCode carries
      // its own cost and never needs the name to price anything.
    }
    return null;
  }

  static bool _hasTable(Database db, String name) => db.select(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    [name],
  ).isNotEmpty;

  static Set<String> _columns(Database db, String table) => {
    for (final row in db.select('PRAGMA table_info($table)'))
      if (row['name'] case final String name) name,
  };

  static int _int(Object? value) =>
      value is num && value.isFinite && value > 0 ? value.toInt() : 0;
}
