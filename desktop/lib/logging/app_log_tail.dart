import 'dart:convert';
import 'dart:io';

import 'install.dart';
import 'log_file.dart';

/// How much of the tail of a log file is worth opening to find recent errors.
///
/// A day's log is unbounded in principle, and this runs while a screen is
/// building — so read the end of the file rather than the file. 64 KB is far
/// more than the last few error lines need and small enough to be free.
const int _tailBytes = 64 * 1024;

/// The last few `ERROR` lines from today's app log, newest last.
///
/// Best-effort by design: this only ever decorates something a person is
/// reading, so a missing directory, a log not yet written, or an unreadable file
/// all mean "nothing to show" rather than a failure the caller must handle.
///
/// [sanitize] runs over the whole tail *before* it is split and clipped, and a
/// caller that sends these lines anywhere must pass one. Before clipping on
/// purpose: a secret cut in half by the clip is still half a secret, and a
/// redactor given the fragment can no longer recognise it.
Future<List<String>> readRecentAppErrors({
  int keep = 3,
  String Function(String)? sanitize,
}) async {
  try {
    final file = File(
      '${DailyLogFile.defaultDirectory.path}/'
      '${dailyLogName(kAppLogBase, DateTime.now())}',
    );
    if (!await file.exists()) return const [];
    final tail = await _readTail(file);
    return recentErrorLines(
      sanitize == null ? tail : sanitize(tail),
      keep: keep,
    );
  } on Object {
    return const [];
  }
}

/// The last [_tailBytes] of [file], decoded leniently — a window that starts
/// mid-character would otherwise throw on an accented path in a log line.
Future<String> _readTail(File file) async {
  final handle = await file.open();
  try {
    final length = await handle.length();
    final from = length > _tailBytes ? length - _tailBytes : 0;
    await handle.setPosition(from);
    final bytes = await handle.read(length - from);
    return const Utf8Decoder(allowMalformed: true).convert(bytes);
  } finally {
    await handle.close();
  }
}

/// The last [keep] error lines in [log], each clipped to [clip] characters.
///
/// Matches the shape [FileAppLog] writes — `[stamp] ERROR category message` —
/// which is also why the indented stack-trace lines that follow an error are
/// left out: they carry paths from this machine, and the one-line summary is
/// what says where to look.
///
/// Pure, so what a person is shown is decided by a function that can be reasoned
/// about rather than by whatever the disk happens to hold.
List<String> recentErrorLines(String log, {int keep = 3, int clip = 200}) {
  final errors = <String>[];
  for (final line in const LineSplitter().convert(log)) {
    if (!line.contains('] ERROR ')) continue;
    errors.add(line.length > clip ? '${line.substring(0, clip)}…' : line);
  }
  if (errors.length <= keep) return errors;
  return errors.sublist(errors.length - keep);
}
