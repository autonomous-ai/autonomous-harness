import 'dart:async';

import 'package:flutter/foundation.dart';

/// Which agent's recent turns. Keyed on the session as well, so a `/clear` that
/// rotates it is a different conversation and is fetched again.
typedef AgentRecallKey = ({
  String machineId,
  String agentId,
  String? sessionId,
});

/// What the machine remembers of one agent's last few turns: the person's own
/// questions, then the recap of each answer.
///
/// This is what lets search find "the one I asked about llama.cpp" when nothing
/// in the agent's name, folder or title says so. The daemon already bounds it
/// (three turns, each clipped); only what a query can match and a row can quote
/// is kept here — the full answer text is dropped on arrival.
@immutable
class AgentRecall {
  AgentRecall(this.lines) : searchText = lines.join('\n').toLowerCase();

  /// Newest first, cleaned, never empty strings.
  final List<String> lines;

  /// [lines], lowercased once, for keystrokes to reuse.
  final String searchText;
}

/// How many turns to ask for, and to keep of each list — the daemon's own cap.
const _turns = 3;

/// A remembered line longer than this is clipped: the daemon's ask limit.
const _lineLimit = 1000;

/// [reply] to `agent_recent`, reduced to its searchable lines.
///
/// Asks first: the person's own words carry the topic ("which llama.cpp build
/// is this?") where a recap tends to carry the outcome.
AgentRecall parseAgentRecall(Map<String, dynamic> reply) {
  final lines = <String>{};
  final asks = reply['asks'];
  if (asks is List) {
    for (final ask in asks.take(_turns)) {
      final line = recallLine(ask);
      if (line != null) lines.add(line);
    }
  }
  final events = reply['events'];
  if (events is List) {
    for (final event in events.take(_turns)) {
      if (event is! Map || event['kind'] != 'summary') continue;
      for (final text in [event['recap'], event['text']]) {
        final line = recallLine(text);
        if (line != null) lines.add(line);
      }
    }
  }
  return AgentRecall(lines.toList());
}

/// [value] as one clean line: terminal escapes and control characters out,
/// whitespace collapsed, clipped to [_lineLimit]. Null when nothing is left.
String? recallLine(Object? value) {
  if (value is! String || value.isEmpty) return null;
  final bounded = value.length > _lineLimit * 2
      ? value.substring(0, _lineLimit * 2)
      : value;
  final text = bounded
      .replaceAll(RegExp(r'\x1b\[[0-?]*[ -/]*[@-~]'), '')
      .replaceAll(RegExp(r'[\x00-\x1f\x7f]+'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  if (text.isEmpty) return null;
  return text.length > _lineLimit ? text.substring(0, _lineLimit) : text;
}

/// A bounded memory of [AgentRecall]s, shared across every time search opens.
///
/// ⚠️ **Warmed when search opens, never per keystroke.** Typing only reads what
/// is already here, so a query on two bars of signal stays instant; the reads
/// happen once, two at a time, for the agents search offers first, and an
/// agent asked about recently is not asked again for [freshFor]. The desktop's
/// Open Agent picker warms the same `agent_recent` replies the same way.
///
/// A machine that cannot answer (an old daemon, a dropped socket) leaves its
/// agents searchable by their metadata alone — never an error on screen.
class AgentRecallStore extends ChangeNotifier {
  AgentRecallStore({
    required this.fetch,
    required this.canFetch,
    this.capacity = 128,
    this.freshFor = const Duration(minutes: 2),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final Future<Map<String, dynamic>> Function(AgentRecallKey key) fetch;

  /// Whether [key]'s machine can be asked right now.
  final bool Function(AgentRecallKey key) canFetch;
  final int capacity;
  final Duration freshFor;
  final DateTime Function() _now;

  /// How many agents one warm reaches, from the front of what it is given.
  static const maxWarm = 24;
  static const _parallel = 2;

  final _recalls = <AgentRecallKey, AgentRecall>{};
  final _attemptedAt = <AgentRecallKey, DateTime>{};
  final _queue = <AgentRecallKey>{};
  final _inFlight = <AgentRecallKey>{};
  bool _disposed = false;

  AgentRecall? read(AgentRecallKey key) => _recalls[key];

  /// Queue [keys] — most wanted first — that have not been asked about lately.
  void warm(Iterable<AgentRecallKey> keys) {
    if (_disposed) return;
    for (final key in keys.take(maxWarm)) {
      if (_inFlight.contains(key) || _askedLately(key) || !canFetch(key)) {
        continue;
      }
      _queue.add(key);
    }
    _drain();
  }

  bool _askedLately(AgentRecallKey key) {
    final at = _attemptedAt[key];
    return at != null && _now().difference(at) < freshFor;
  }

  void _drain() {
    while (!_disposed && _inFlight.length < _parallel && _queue.isNotEmpty) {
      final key = _queue.first;
      _queue.remove(key);
      if (_askedLately(key) || !canFetch(key)) continue;
      _bounded(_attemptedAt, key, _now());
      _inFlight.add(key);
      unawaited(_load(key));
    }
  }

  Future<void> _load(AgentRecallKey key) async {
    try {
      final reply = await fetch(key);
      if (_disposed || !_answers(reply, key)) return;
      _bounded(_recalls, key, parseAgentRecall(reply));
      notifyListeners();
    } on Object {
      // Searched by its metadata until the next warm after [freshFor].
    } finally {
      _inFlight.remove(key);
      _drain();
    }
  }

  static bool _answers(Map<String, dynamic> reply, AgentRecallKey key) =>
      reply['error'] == null &&
      (reply['agentId'] == null || reply['agentId'] == key.agentId);

  /// Writes [key] as the newest entry of [map], dropping the oldest past
  /// [capacity].
  void _bounded<V>(Map<AgentRecallKey, V> map, AgentRecallKey key, V value) {
    map
      ..remove(key)
      ..[key] = value;
    while (map.length > capacity) {
      map.remove(map.keys.first);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _queue.clear();
    super.dispose();
  }
}
