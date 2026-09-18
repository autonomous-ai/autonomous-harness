/// Ported from the desktop's `lib/state/session_preview.dart`, so a phone
/// search reaches the same session content the desktop's Open Agent picker
/// does. Keep the two in step; the additions here are
/// [SessionPreview.searchParts], which the phone's result rows quote from, and
/// [SessionPreviewStore.markStale], for turns a sleeping phone never heard.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

typedef SessionPreviewKey = ({
  String machineId,
  String agentId,
  String? sessionId,
});

/// Existing session excerpts only. This store never starts a model, reads a
/// transcript, attaches a terminal, or sends input to an agent.
class SessionPreview {
  final List<String> requests = [];
  final List<String> earlierResponses = [];
  String? currentRequest, liveText, completedText, savedText, activity;
  String _streamText = '';
  String? _searchText;
  bool turnOpen = false,
      interrupted = false,
      fetched = false,
      unavailable = false;
  DateTime? receivedAt;
  DateTime? _attemptedAt;
  int _revision = 0;

  String? get latestRequest => requests.firstOrNull;
  String? get earlierRequest =>
      latestRequest != null &&
          RegExp(
            r'^(ok(ay)?|yes|yeah|sure|continue|go ahead|thanks?|thank you|commit( and| &) push|commit and push)[.! ]*$',
            caseSensitive: false,
          ).hasMatch(latestRequest!)
      ? requests.skip(1).firstOrNull
      : null;
  String? get response => completedText ?? savedText;
  String? get responseExcerpt {
    final text = response;
    if (text == null || completedText != null || contextResponse == text) {
      return text;
    }
    // Cached fullText may include the "I'll commit" preamble before the final
    // receipt. Keep the existing outcome paragraphs, not just the preamble.
    final paragraphs = text.split(RegExp(r'\n\s*\n'));
    return paragraphs
        .skip(paragraphs.length > 2 ? paragraphs.length - 2 : 0)
        .join('\n\n');
  }

  // A commit receipt often follows the actual explanation. Reuse an earlier
  // existing response for compact group context, keeping the receipt available
  // as the latest response in the full preview. This is text selection only.
  String? get contextResponse =>
      response != null &&
          RegExp(
            r"^(?:(?:i['’]ll|i will|i['’]m)\s+)?(?:commit(?:ted|ting)?|push(?:ed|ing)?)\b",
            caseSensitive: false,
          ).hasMatch(response!.trimLeft()) &&
          earlierResponses.isNotEmpty
      ? earlierResponses.first
      : response;
  bool get hasContent =>
      latestRequest != null || liveText != null || response != null;

  /// The bounded excerpts search reaches, as written — what a phone result row
  /// quotes when a word matched only here.
  List<String> get searchParts => {
    currentRequest,
    latestRequest,
    earlierRequest,
    liveText,
    responseExcerpt,
    ...earlierResponses,
    activity,
  }.whereType<String>().toList();

  /// A lazy, normalized field over the same bounded excerpts as the preview.
  /// Keystrokes reuse it; it owns no history or separate search index.
  String get searchText => _searchText ??= searchParts.join('\n').toLowerCase();

  void _rememberRequest(Object? value) {
    final text = previewText(value, limit: 1600);
    if (text == null) return;
    requests.remove(text);
    requests.insert(0, text);
    if (requests.length > 3) requests.removeLast();
  }
}

/// Bounded memory shared across picker openings. Inventory warms small cached
/// `agent_recent` replies with two requests at a time. Selection reads memory;
/// a settled cold selection may schedule the same inexpensive background read.
class SessionPreviewStore extends ChangeNotifier {
  SessionPreviewStore({
    required this.fetchRecent,
    required this.canFetch,
    this.capacity = 256,
    this.freshFor = const Duration(minutes: 1),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final Future<Map<String, dynamic>> Function(SessionPreviewKey) fetchRecent;
  final bool Function(SessionPreviewKey) canFetch;
  final int capacity;
  final Duration freshFor;
  final DateTime Function() _now;
  final _records = <SessionPreviewKey, SessionPreview>{};
  final _queue = <SessionPreviewKey>{};
  final _inFlight = <SessionPreviewKey>{};
  Timer? _publish;
  bool _disposed = false;

  SessionPreview? read(SessionPreviewKey key) => _records[key];

  /// Lets the next [warm] read [key] again, inside [freshFor] or not — for a
  /// session its machine says has moved since this copy was taken.
  ///
  /// ⚠️ A phone needs this where the desktop does not. iOS suspends the socket
  /// in the background, so a reply that lands meanwhile never arrives as live
  /// events; without this the copy taken before it stays the one searched
  /// until [freshFor] runs out and something happens to warm it again.
  void markStale(SessionPreviewKey key) => _records[key]?._attemptedAt = null;

  SessionPreview _entry(SessionPreviewKey key) {
    final entry = _records.remove(key) ?? SessionPreview();
    entry._searchText = null;
    _records[key] = entry;
    while (_records.length > capacity) {
      _records.remove(_records.keys.first);
    }
    return entry;
  }

  void warm(Iterable<SessionPreviewKey> keys, {bool prioritize = false}) {
    if (_disposed) return;
    final pending = <SessionPreviewKey>[];
    for (final key in keys.take(32)) {
      if (_inFlight.contains(key) || !canFetch(key)) continue;
      final attempted = read(key)?._attemptedAt;
      if (attempted != null && _now().difference(attempted) < freshFor) {
        continue;
      }
      pending.add(key);
    }
    if (prioritize) {
      final rest = _queue.toList();
      _queue
        ..clear()
        ..addAll(pending)
        ..addAll(rest);
    } else {
      _queue.addAll(pending);
    }
    while (_queue.length > 64) {
      _queue.remove(_queue.last);
    }
    _drain();
  }

  void _drain() {
    while (!_disposed && _inFlight.length < 2 && _queue.isNotEmpty) {
      final key = _queue.first;
      _queue.remove(key);
      if (!canFetch(key)) continue;
      final entry = _entry(key);
      final attempted = entry._attemptedAt;
      if (attempted != null && _now().difference(attempted) < freshFor) {
        continue;
      }
      entry._attemptedAt = _now();
      _inFlight.add(key);
      unawaited(_fetch(key, entry));
    }
  }

  Future<void> _fetch(SessionPreviewKey key, SessionPreview entry) async {
    final revision = entry._revision;
    bool current() =>
        !_disposed && identical(read(key), entry) && canFetch(key);
    try {
      final reply = await fetchRecent(key);
      if (!current()) return;
      if (reply['error'] != null ||
          (reply['agentId'] != null && reply['agentId'] != key.agentId)) {
        entry.unavailable = true;
      } else if (entry._revision == revision) {
        final asks = reply['asks'];
        if (asks is List) {
          for (final ask in asks.take(3).toList().reversed) {
            entry._rememberRequest(ask);
          }
        }
        final events = reply['events'];
        if (events is List) {
          final responses = <String>[];
          for (final event in events.take(3)) {
            if (event is! Map || event['kind'] != 'summary') continue;
            final text =
                previewText(event['fullText'], limit: 6000) ??
                previewText(event['text'], limit: 6000) ??
                previewText(event['recap'], limit: 6000);
            if (text != null && !responses.contains(text)) responses.add(text);
          }
          if (responses.isNotEmpty) {
            entry.savedText = responses.first;
            entry.earlierResponses
              ..clear()
              ..addAll(responses.skip(1));
          }
        }
        // Asks and summaries are independent lists, with no shared turn id.
        // They deliberately remain separate: this is never a paired exchange.
        entry.unavailable = false;
        entry.receivedAt = _now();
      }
      entry.fetched = true;
      entry._searchText = null;
      _changed();
    } catch (_) {
      if (current()) {
        entry.unavailable = true;
        entry.fetched = true;
        _changed();
      }
    } finally {
      _inFlight.remove(key);
      _drain();
    }
  }

  /// The ordinary session stream supplies actual requests, answer text and
  /// tool names. Reasoning, tool output and terminal bytes are not retained.
  void ingest(
    SessionPreviewKey key,
    String type,
    Map<String, dynamic> payload, {
    bool streamingText = false,
  }) {
    if (_disposed || !eventTypes.contains(type)) return;
    final entry = _entry(key);
    entry._revision++;
    entry.receivedAt = _now();
    entry.unavailable = false;
    switch (type) {
      case 'turn_started':
        entry.turnOpen = true;
        entry.interrupted = false;
        entry.currentRequest = previewText(payload['userMessage'], limit: 1600);
        entry._rememberRequest(entry.currentRequest);
        entry.liveText = null;
        entry._streamText = '';
        entry.activity = null;
      case 'user_message':
        entry._rememberRequest(payload['content']);
        if (entry.turnOpen) entry.currentRequest = entry.latestRequest;
      case 'text_delta':
        final raw = payload['content'];
        if (raw is String && raw.isNotEmpty) {
          if (streamingText) {
            final combined = '${entry._streamText}$raw';
            entry._streamText = combined.length > 6500
                ? combined.substring(combined.length - 6500)
                : combined;
          }
          entry.liveText = previewText(
            streamingText ? entry._streamText : raw,
            limit: 6000,
            tail: true,
          );
          entry.activity = null;
        }
      case 'tool_start':
        entry._streamText = '';
        entry.activity = previewText(payload['tool'], limit: 100);
      case 'tool_end':
        if (entry.activity == previewText(payload['tool'], limit: 100)) {
          entry.activity = null;
        }
      case 'turn_ended':
        entry.turnOpen = false;
        entry.interrupted = payload['aborted'] == true;
        if (entry.liveText != null) entry.completedText = entry.liveText;
        entry.liveText = null;
        entry.activity = null;
    }
    _changed();
  }

  static const eventTypes = {
    'turn_started',
    'user_message',
    'text_delta',
    'tool_start',
    'tool_end',
    'turn_ended',
  };

  void retainAgent(String machineId, String agentId, String? sessionId) {
    bool obsolete(SessionPreviewKey key) =>
        key.machineId == machineId &&
        key.agentId == agentId &&
        key.sessionId != sessionId;
    _records.removeWhere((key, _) => obsolete(key));
    _queue.removeWhere(obsolete);
  }

  void removeAgent(String machineId, String agentId) {
    bool matches(SessionPreviewKey key) =>
        key.machineId == machineId && key.agentId == agentId;
    _records.removeWhere((key, _) => matches(key));
    _queue.removeWhere(matches);
  }

  void clear() {
    _records.clear();
    _queue.clear();
    _publish?.cancel();
    _publish = null;
  }

  // Text deltas never notify the whole app or rebuild the search editor.
  // At most one preview repaint per 80 ms, even with several working agents.
  void _changed() {
    _publish ??= Timer(const Duration(milliseconds: 80), () {
      _publish = null;
      if (!_disposed) notifyListeners();
    });
  }

  @override
  void dispose() {
    _disposed = true;
    clear();
    super.dispose();
  }
}

String? previewText(Object? value, {required int limit, bool tail = false}) {
  if (value is! String || value.isEmpty) return null;
  // Bound work before cleanup as well as retained memory. No markdown or escape
  // sequence in session text is executable or rendered as HTML.
  var text = value.length > limit * 2
      ? tail
            ? value.substring(value.length - limit * 2)
            : value.substring(0, limit * 2)
      : value;
  text = text
      .replaceAll(RegExp(r'\x1b\[[0-?]*[ -/]*[@-~]'), '')
      .replaceAll(RegExp(r'[\x00-\x08\x0b-\x1f\x7f]'), '')
      .trim();
  if (text.isEmpty) return null;
  if (text.length > limit) {
    text = tail
        ? '…${text.substring(text.length - limit)}'
        : '${text.substring(0, limit)}…';
  }
  return text;
}
