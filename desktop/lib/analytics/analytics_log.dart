import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:flutter/foundation.dart';

/// Where one tracked event got to.
enum AnalyticsEventStatus {
  /// In the queue: never sent, or sent and waiting on a retry.
  queued,

  /// The server took it.
  sent,

  /// The server refused it (a 4xx that isn't 408/429) — our instrumentation is
  /// wrong, not the network.
  refused,

  /// Never reached the wire: an invalid name, a full queue, or a build whose
  /// stream is muted.
  dropped,
}

/// One tracked event as Settings ▸ Tracking shows it: what was tracked, what
/// went over the wire, and how it ended.
///
/// Mutable in place, like [LogEntry] and unlike Grid's immutable
/// `AnalyticsLogEntry`: Grid rebuilds through `copyWith` because Riverpod
/// compares state objects, while this buffer is a [ChangeNotifier] and an event
/// that is still retrying collects its attempts on the entry it already has.
class AnalyticsLogEntry {
  AnalyticsLogEntry({
    required this.id,
    required this.name,
    required this.params,
    required this.queuedAt,
  });

  /// Monotonic within a session — the handle the queue settles a row by.
  final int id;

  final String name;

  /// The params as the call site passed them, before the context and the
  /// identity are merged in. [payload] is what actually went out.
  final Map<String, Object?> params;

  final DateTime queuedAt;

  AnalyticsEventStatus status = AnalyticsEventStatus.queued;

  /// How many times this event has been put on the wire. Two or more means the
  /// endpoint failed and the queue retried, which is the thing this screen
  /// exists to make visible.
  int attempts = 0;

  /// The exact JSON body sent, re-indented, or null before the first attempt.
  String? payload;

  /// Why it ended the way it did, when the status alone doesn't say.
  String? note;

  DateTime? settledAt;

  /// How long from being tracked to being settled, or null while it waits.
  Duration? get took => settledAt?.difference(queuedAt);
}

/// The recorder the analytics queue reports to.
///
/// An interface so the queue stays free of the screen, and so a release build —
/// which has no Tracking screen — pays nothing for it. The same seam
/// `AnalyticsClient` gives the transport.
abstract interface class AnalyticsLog {
  /// Records an event entering the queue; returns its id for the calls below.
  int queued(String name, Map<String, Object?> params, DateTime at);

  /// Records that [payload] has just gone on the wire for entry [id]. Called
  /// once per attempt, so the count reads as retries.
  ///
  /// Takes the payload as the map the queue already built rather than as a
  /// string: encoding it is the recorder's business, and a build with nothing
  /// recording must not pay for a `jsonEncode` per event.
  void attempted(int id, Map<String, Object?> payload);

  /// Records how entry [id] ended.
  void settled(int id, AnalyticsEventStatus status, {String? note});
}

/// Records nothing — what a release build gets, so the queue can run with no
/// screen watching.
class NoopAnalyticsLog implements AnalyticsLog {
  const NoopAnalyticsLog();

  @override
  int queued(String name, Map<String, Object?> params, DateTime at) => 0;

  @override
  void attempted(int id, Map<String, Object?> payload) {}

  @override
  void settled(int id, AnalyticsEventStatus status, {String? note}) {}
}

/// The events this session tracked, newest first — a bounded ring, fed by
/// `QueuedAnalytics` and read by Settings ▸ Tracking.
///
/// In memory only, and deliberately: this is a window onto a queue that is
/// itself in memory, and a stream that measures the app must not become a
/// second thing the app writes to disk on every click. It is the one place the
/// question analytics always raises can be answered — *did that event actually
/// leave, and what was in it?* — because an event that was never sent, sent
/// with a missing field, or refused by the server looks exactly like an event
/// that landed: the app is silent either way, by design.
class AnalyticsLogStream extends ChangeNotifier implements AnalyticsLog {
  AnalyticsLogStream({this.maxEntries = 200});

  /// How many events the buffer keeps. Smaller than [LogStream]'s 500: one row
  /// here is one deliberate product event, not a socket frame, and a session
  /// that has tracked two hundred of them has long since answered the question
  /// this screen was opened with.
  final int maxEntries;

  final List<AnalyticsLogEntry> _entries = [];
  int _seq = 0;
  bool _notifyScheduled = false;

  /// Newest first — the order the Tracking list reads in.
  late final UnmodifiableListView<AnalyticsLogEntry> entries =
      UnmodifiableListView(_entries);

  @override
  int queued(String name, Map<String, Object?> params, DateTime at) {
    final id = ++_seq;
    _entries.insert(
      0,
      AnalyticsLogEntry(
        id: id,
        name: name,
        // Copied, so a caller that reuses its map cannot rewrite history here.
        params: Map<String, Object?>.unmodifiable(params),
        queuedAt: at,
      ),
    );
    if (_entries.length > maxEntries) {
      _entries.removeRange(maxEntries, _entries.length);
    }
    _scheduleNotify();
    return id;
  }

  @override
  void attempted(int id, Map<String, Object?> payload) {
    final entry = _entryFor(id);
    if (entry == null) return;
    entry.attempts += 1;
    entry.payload = _pretty(payload);
    _scheduleNotify();
  }

  @override
  void settled(int id, AnalyticsEventStatus status, {String? note}) {
    final entry = _entryFor(id);
    if (entry == null) return;
    entry.status = status;
    entry.note = note;
    entry.settledAt = DateTime.now();
    _scheduleNotify();
  }

  void clear() {
    if (_entries.isEmpty) return;
    _entries.clear();
    _scheduleNotify();
  }

  /// An event settles near where it was queued, and the newest rows are at the
  /// front — so this walks a handful of entries, not the buffer. Null once a
  /// row has been pushed out by [maxEntries] or dropped by [clear], which the
  /// callers treat as "nothing left to update" rather than as an error.
  AnalyticsLogEntry? _entryFor(int id) {
    for (final entry in _entries) {
      if (entry.id == id) return entry;
    }
    return null;
  }

  /// One notification per microtask, however many rows changed in it — the
  /// same rhythm [LogStream] keeps, for the same reason: a queue draining after
  /// a reconnect settles a run of events in one pass.
  void _scheduleNotify() {
    if (_notifyScheduled) return;
    _notifyScheduled = true;
    scheduleMicrotask(() {
      _notifyScheduled = false;
      notifyListeners();
    });
  }

  /// The body as it went out, re-indented so the dialog can be read.
  ///
  /// A payload that will not encode costs its own readability and nothing else
  /// — this is a debug view of an event that has *already been sent*, and
  /// throwing here would take the row with it.
  static String _pretty(Map<String, Object?> payload) {
    try {
      return const JsonEncoder.withIndent('  ').convert(payload);
    } on Object {
      return payload.toString();
    }
  }
}

/// This session's tracked events. Fed only where the Tracking screen exists —
/// see `analyticsRecorder` in `analytics_sink.dart`.
final AnalyticsLogStream analyticsLog = AnalyticsLogStream();
