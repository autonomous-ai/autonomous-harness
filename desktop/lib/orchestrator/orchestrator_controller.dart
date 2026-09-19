import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

typedef OrchestratorRequest = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> payload,
);

String orchestratorRequestId() {
  final random = Random.secure();
  return List.generate(
    16,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

class OrchestratorTask {
  OrchestratorTask(this.data);
  final Map<String, dynamic> data;
  String get id => data['id'] as String;
  String get title => data['title'] as String? ?? id;
  String get state => data['state'] as String? ?? 'queued';
  String get harness => data['harness'] as String? ?? '';
  String? get agentId => data['agentId'] as String?;
  int get attempt => data['attempt'] as int? ?? 1;
  String? get error => data['error'] as String? ?? runtime?['error'] as String?;
  String get summary => data['summary'] as String? ?? '';
  bool get uncertain => data['uncertain'] == true;
  bool get hasViewer => data['hasViewer'] != false;
  Map<String, dynamic>? get runtime =>
      (data['runtime'] as Map?)?.cast<String, dynamic>();
  String? get viewerUrl => runtime?['viewerUrl'] as String?;
  String get viewerName => runtime?['viewerName'] as String? ?? title;
  List<String> get artifacts => [
    for (final file in data['artifacts'] as List? ?? [])
      if (file is Map && file['path'] is String) file['path'] as String,
  ];
}

/// A projection of daemon-owned work. Mounting a view only starts reads; disposing
/// it never sends stop, delete, or create. Drafts survive tab switches in memory.
class OrchestratorController extends ChangeNotifier {
  OrchestratorController({
    required this.id,
    required this.request,
    this.pollInterval = const Duration(seconds: 3),
  });
  final String id;
  final OrchestratorRequest request;
  final Duration pollInterval;
  Map<String, dynamic>? project;
  String? error;
  String draft = '';
  bool sending = false;
  bool operating = false;
  Timer? _poll, _coalesce;
  Future<void>? _refresh;
  String? _pendingMessageId, _pendingMessageText;
  bool _disposed = false;
  int _readers = 0;

  String get state => project?['state'] as String? ?? 'connecting';
  String? get directorId => project?['directorId'] as String?;
  bool get directorWorking => project?['directorWorking'] == true;
  bool get canChat =>
      directorId != null && (state == 'active' || state == 'completed');
  List<OrchestratorTask> get tasks => [
    for (final task in project?['tasks'] as List? ?? [])
      if (task is Map) OrchestratorTask(task.cast<String, dynamic>()),
  ];
  List<Map<String, dynamic>> get messages => [
    for (final m in project?['messages'] as List? ?? [])
      if (m is Map) m.cast<String, dynamic>(),
  ];

  void watch() {
    if (_disposed || _readers++ > 0) return;
    unawaited(refresh());
    _poll = Timer.periodic(pollInterval, (_) => unawaited(refresh()));
  }

  void unwatch() {
    if (_readers > 0) _readers--;
    if (_readers > 0) return;
    _poll?.cancel();
    _poll = null;
    _coalesce?.cancel();
    _coalesce = null;
  }

  void changed() {
    if (_disposed || _readers == 0 || _coalesce != null) return;
    _coalesce = Timer(const Duration(milliseconds: 180), () {
      _coalesce = null;
      unawaited(refresh());
    });
  }

  void _apply(Map<String, dynamic> reply) {
    if (_disposed) return;
    if (reply['error'] != null) {
      throw StateError(reply['detail'] as String? ?? reply['error'].toString());
    }
    final incoming = (reply['project'] as Map?)?.cast<String, dynamic>();
    if (incoming != null &&
        incoming['id'] == id &&
        (incoming['revision'] as num? ?? 0) >=
            (project?['revision'] as num? ?? -1)) {
      project = incoming;
    }
    error = null;
    notifyListeners();
  }

  Future<void> refresh() =>
      _refresh ??= _read().whenComplete(() => _refresh = null);
  Future<void> _read() async {
    try {
      _apply(await request({'action': 'status', 'id': id}));
    } catch (e) {
      if (!_disposed) {
        error = e.toString();
        notifyListeners();
      }
    }
  }

  Future<bool> perform(String action, {String? taskId}) async {
    if (operating || _disposed) return false;
    operating = true;
    notifyListeners();
    try {
      _apply(await request({'action': action, 'id': id, 'taskId': ?taskId}));
      return true;
    } catch (e) {
      if (!_disposed) error = e.toString();
      return false;
    } finally {
      if (!_disposed) {
        operating = false;
        notifyListeners();
      }
    }
  }

  Future<bool> send(String text) async {
    if (sending || _disposed || text.trim().isEmpty) return false;
    if (_pendingMessageText != text) {
      _pendingMessageId = orchestratorRequestId();
      _pendingMessageText = text;
    }
    sending = true;
    notifyListeners();
    try {
      _apply(
        await request({
          'action': 'message',
          'id': id,
          'messageId': _pendingMessageId,
          'text': text,
        }),
      );
      _pendingMessageId = null;
      _pendingMessageText = null;
      if (draft == text) draft = '';
      return true;
    } catch (e) {
      if (!_disposed) error = e.toString();
      return false;
    } finally {
      if (!_disposed) {
        sending = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    _coalesce?.cancel();
    super.dispose();
  }
}
