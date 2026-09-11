import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';

import 'app_log.dart';

/// How a [LogEntry] ended, as the Debug list draws it.
enum LogStatus { running, ok, failed, warned, event }

/// One thing the app did, held in memory for Settings ▸ Debug.
///
/// The same events the file sinks write — this is a *mirror* of them, not a
/// second stream (see `log_stream_sinks.dart`), so what the screen shows and
/// what a support bundle would carry can never disagree.
///
/// Deliberately mutable, unlike Grid's `GridCommandLog`, which is immutable and
/// re-created through `copyWith` because Riverpod compares state objects. This
/// buffer is a [ChangeNotifier]: a command that is still running collects its
/// output lines and its exit code in place, and the one notification that
/// follows is what the list rebuilds on.
class LogEntry {
  LogEntry({
    required this.id,
    required this.at,
    required this.level,
    required this.category,
    required this.message,
    this.error,
    this.stackTrace,
    this.command,
  });

  /// Monotonic within a session — also the id [LogStream] updates a running
  /// command by.
  final int id;

  final DateTime at;

  /// `app`, `ws`, `cli`, `api`, `flutter` — [AppLog]'s own tag, which is what
  /// the Debug screen's lenses are built from.
  final String category;

  /// The line as the log file holds it, minus the stamp and the level.
  final String message;

  /// Decided when a command ends, so a non-zero exit reads as an error without
  /// the caller having to say so twice.
  AppLogLevel level;

  final String? error;
  final String? stackTrace;

  /// Present only for a CLI invocation — the transcript behind [message].
  final LogCommand? command;

  LogStatus get status {
    final invocation = command;
    if (invocation == null) {
      return switch (level) {
        AppLogLevel.error => LogStatus.failed,
        AppLogLevel.warn => LogStatus.warned,
        _ => LogStatus.event,
      };
    }
    if (invocation.running) return LogStatus.running;
    return invocation.failed ? LogStatus.failed : LogStatus.ok;
  }

  /// Whether opening the row would show anything the row itself does not.
  bool get hasDetail =>
      error != null ||
      stackTrace != null ||
      (command?.output.isNotEmpty ?? false);
}

/// One CLI invocation's transcript: its output as it arrives, and how it ended.
class LogCommand {
  /// Output lines, oldest first. `!` lines are stderr, tagged at the sink so
  /// the detail dialog can colour them without a second list.
  final List<String> output = [];

  bool running = true;
  int? exitCode;
  Duration? duration;
  String? error;

  /// Set once [LogStream.maxOutputLines] is reached — said out loud rather than
  /// trailing off, so nobody reads a clipped transcript as the whole one.
  bool clipped = false;

  bool get failed => error != null || (exitCode != null && exitCode != 0);
}

/// The app's own log, as the running app still holds it: a bounded ring of the
/// most recent entries, newest first.
///
/// Fed by [StreamAppLog]/[StreamCliLog], read by Settings ▸ Debug. A singleton
/// like `appLog` and `analytics`, and for the same reason: the things that
/// write to it — the socket, the CLI runners, the HTTP clients — hold no `Ref`
/// and no notifier between them.
class LogStream extends ChangeNotifier {
  LogStream({this.maxEntries = 500, this.maxOutputLines = 300});

  /// How many entries the buffer keeps. Past this the oldest are dropped: this
  /// is the tail of a session, and the whole day is on disk.
  final int maxEntries;

  /// Per-command output cap. An installer prints a progress line per second;
  /// two hundred of those is the app's memory, not a debug aid.
  final int maxOutputLines;

  final List<LogEntry> _entries = [];
  int _seq = 0;
  bool _notifyScheduled = false;

  /// Newest first — the order the Debug list reads in, so the newest line is
  /// the one on screen without scrolling.
  late final UnmodifiableListView<LogEntry> entries = UnmodifiableListView(
    _entries,
  );

  /// Records one event. Returns its id, which [appendOutput] and [finish] take.
  int add(
    AppLogLevel level,
    String category,
    String message, {
    String? error,
    String? stackTrace,
    LogCommand? command,
  }) {
    final id = ++_seq;
    _entries.insert(
      0,
      LogEntry(
        id: id,
        at: DateTime.now(),
        level: level,
        category: category,
        message: message,
        error: error,
        stackTrace: stackTrace,
        command: command,
      ),
    );
    if (_entries.length > maxEntries) {
      _entries.removeRange(maxEntries, _entries.length);
    }
    _scheduleNotify();
    return id;
  }

  /// Appends one line of a running command's output.
  void appendOutput(int id, String line, {bool isError = false}) {
    final command = _commandFor(id);
    if (command == null) return;
    if (command.output.length >= maxOutputLines) {
      command.clipped = true;
      return;
    }
    command.output.add('${isError ? '! ' : '  '}$line');
    _scheduleNotify();
  }

  /// Closes a command out. A non-zero exit or an [error] also raises the
  /// entry's level, so it lands in the Failed lens without a second call.
  void finish(int id, {int? exitCode, Duration? duration, String? error}) {
    final entry = _entryFor(id);
    final command = entry?.command;
    if (entry == null || command == null || !command.running) return;
    command
      ..running = false
      ..exitCode = exitCode
      ..duration = duration
      ..error = error;
    if (command.failed) entry.level = AppLogLevel.error;
    _scheduleNotify();
  }

  void clear() {
    if (_entries.isEmpty) return;
    _entries.clear();
    _scheduleNotify();
  }

  LogEntry? _entryFor(int id) {
    // A command finishes near where it started, and the newest entries are at
    // the front — so this walks a handful of rows, not the buffer.
    for (final entry in _entries) {
      if (entry.id == id) return entry;
    }
    return null;
  }

  LogCommand? _commandFor(int id) {
    final command = _entryFor(id)?.command;
    return command != null && command.running ? command : null;
  }

  /// One notification per microtask, however many lines arrived in it.
  ///
  /// A CLI command's output lands line by line and a busy socket writes several
  /// frames per frame of UI; notifying on each would rebuild the Debug list
  /// dozens of times for one visible change.
  void _scheduleNotify() {
    if (_notifyScheduled) return;
    _notifyScheduled = true;
    scheduleMicrotask(() {
      _notifyScheduled = false;
      notifyListeners();
    });
  }
}

/// The app's in-memory log mirror. Empty unless [installFileLogs] wired the
/// mirroring sinks — which it only does where the Debug screen exists.
final LogStream logStream = LogStream();
