/// The seam a provider implements to be scanned, and the incremental cache
/// every scan is measured against.
///
/// The three providers agree on nothing but the question. Claude and Codex write
/// append-only JSONL; OpenCode keeps a SQLite database. Claude bills per
/// assistant turn, Codex per `token_count` event, OpenCode per session. What
/// they do share is that **their files are append-mostly and enormous**, so
/// re-reading everything on every refresh is the thing this contract exists to
/// avoid: a scan is handed what the last one saw and returns only what changed.
library;

import 'dart:io';

import 'ledger_types.dart';

/// One file or database a scan read, and what came out of it.
///
/// [mtimeMs] and [size] together are the fingerprint. Cheap to take, and between
/// them they catch every edit an agent CLI actually makes — these are
/// append-only logs, so a write moves both. A hash would be exact and would cost
/// a full read of the very file the fingerprint exists to avoid reading.
class ScannedSource {
  const ScannedSource({
    required this.path,
    required this.mtimeMs,
    required this.size,
    required this.entries,
  });

  final String path;
  final int mtimeMs;
  final int size;

  /// What this source contributed, oldest first.
  final List<LedgerEntry> entries;

  bool matches(FileStat stat) =>
      stat.modified.millisecondsSinceEpoch == mtimeMs && stat.size == size;

  Map<String, Object?> toJson() => {
    'path': path,
    'mtimeMs': mtimeMs,
    'size': size,
    'entries': [for (final entry in entries) entry.toJson()],
  };

  static ScannedSource? fromJson(
    LedgerProvider provider,
    Map<String, Object?> json,
  ) {
    final path = json['path'];
    if (path is! String) return null;
    final entries = json['entries'];
    return ScannedSource(
      path: path,
      mtimeMs: (json['mtimeMs'] as num?)?.toInt() ?? 0,
      size: (json['size'] as num?)?.toInt() ?? 0,
      entries: [
        if (entries is List)
          for (final raw in entries)
            if (raw is Map<String, Object?>)
              ?LedgerEntry.fromJson(provider, raw),
      ],
    );
  }
}

/// What one scan produced.
///
/// [status] is on the result rather than thrown, for the same reason
/// `UsageSource.read` never throws: the panel has to draw *something*, and a
/// scanner that threw would make its caller invent the sentence instead of the
/// scanner that knows it.
class LedgerScanResult {
  const LedgerScanResult({
    this.sources = const [],
    this.status = LedgerStatus.ok,
    this.message,
  });

  /// Every source seen — including ones served from cache untouched, so the next
  /// scan can be measured against a complete picture rather than a delta of a
  /// delta.
  final List<ScannedSource> sources;

  final LedgerStatus status;
  final String? message;

  /// The state for a provider whose files are simply not on this machine.
  ///
  /// [LedgerStatus.unavailable] rather than an empty ok: "you do not have
  /// OpenCode" and "you have OpenCode and have spent nothing" are different
  /// answers, and only one of them is worth a Retry.
  const LedgerScanResult.unavailable(String this.message)
    : sources = const [],
      status = LedgerStatus.unavailable;
}

abstract class LedgerScanner {
  LedgerProvider get provider;

  /// Read what changed since [previous], keyed by source path.
  ///
  /// An implementation is expected to reuse a [ScannedSource] whose fingerprint
  /// still matches rather than re-parsing it.
  Future<LedgerScanResult> scan(Map<String, ScannedSource> previous);
}

/// Every `.jsonl` under [roots], deepest first, with unreadable roots skipped.
///
/// Skipped rather than reported: a missing `~/.codex` means that CLI was never
/// run here, which is the ordinary case for two of the three providers on any
/// given machine and not worth a sentence on screen.
Future<List<File>> listJsonlFiles(Iterable<String> roots) async {
  final seen = <String>{};
  final files = <File>[];
  for (final root in roots) {
    final directory = Directory(root);
    if (!await directory.exists()) continue;
    try {
      await for (final entity in directory.list(
        recursive: true,
        followLinks: false,
      )) {
        if (entity is! File || !entity.path.endsWith('.jsonl')) continue;
        if (seen.add(entity.path)) files.add(entity);
      }
    } on FileSystemException {
      // A single unreadable subtree must not hide the roots beside it.
      continue;
    }
  }
  files.sort((a, b) => a.path.compareTo(b.path));
  return files;
}

/// The current user's home, or null when the environment names none.
///
/// Null rather than a throw: every caller here is a scanner, and a scanner with
/// nowhere to look reports [LedgerStatus.unavailable] like any other machine
/// that has nothing to read.
String? homeDirectory([Map<String, String>? environment]) {
  final env = environment ?? Platform.environment;
  final home = env['HOME'];
  if (home != null && home.isNotEmpty) return home;
  if (Platform.isWindows) {
    final profile = env['USERPROFILE'];
    if (profile != null && profile.isNotEmpty) return profile;
  }
  return null;
}
