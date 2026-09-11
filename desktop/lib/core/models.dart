/// Data models mirroring the backend/web types.
library;

enum MachineAuthMode { managed, remote, self, provider }

enum ConnectionStatus { disconnected, connecting, connected, reconnecting }

/// Current SSO identity returned by GET /api/auth/me.
class CurrentUserProfile {
  final String? id;
  final String? name;
  final String email;
  final String? avatarUrl;

  const CurrentUserProfile({
    this.id,
    this.name,
    required this.email,
    this.avatarUrl,
  });

  const CurrentUserProfile.local()
    : id = null,
      name = 'Local session',
      email = 'local terminal',
      avatarUrl = null;

  factory CurrentUserProfile.fromMe(Map<String, dynamic> response) {
    final rawUser = response['user'];
    if (rawUser is! Map) {
      throw const FormatException('missing user profile');
    }
    final user = Map<String, dynamic>.from(rawUser);
    final email = user['email'];
    if (email is! String || email.trim().isEmpty) {
      throw const FormatException('missing user email');
    }
    final rawName = user['name'];
    final rawAvatar = response['avatarUrl'];
    return CurrentUserProfile(
      id: user['id'] is String ? user['id'] as String : null,
      name: rawName is String && rawName.trim().isNotEmpty
          ? rawName.trim()
          : null,
      email: email.trim(),
      avatarUrl: rawAvatar is String && rawAvatar.trim().isNotEmpty
          ? rawAvatar.trim()
          : null,
    );
  }

  String get displayName => name ?? email;

  String get initials {
    final source = (name ?? email).trim();
    if (source.isEmpty) return '?';
    final words = source.split(RegExp(r'\s+')).where((word) => word.isNotEmpty);
    final chars = words.take(2).map((word) => word[0].toUpperCase()).join();
    return chars.isEmpty ? '?' : chars;
  }
}

/// Control-plane machine (GET /api/machines).
class Machine {
  final String machineId;

  /// Legacy fixture-only field. Production `/api/machines` no longer exposes machine API keys.
  final String apiKey;
  final String? computerId;
  final MachineAuthMode authMode;
  final String? engine;
  final String? name;
  final String? hostname;
  final String? status;

  const Machine({
    required this.machineId,
    this.apiKey = '',
    this.computerId,
    required this.authMode,
    this.engine,
    this.name,
    this.hostname,
    this.status,
  });

  String get displayName => (name != null && name!.isNotEmpty)
      ? name!
      : 'machine-${machineId.length > 8 ? machineId.substring(0, 8) : machineId}';

  factory Machine.fromJson(Map<String, dynamic> j) => Machine(
    machineId: j['machineId'] as String,
    apiKey: j['apiKey'] as String? ?? '',
    computerId: j['computerId'] as String?,
    authMode: MachineAuthMode.values.firstWhere(
      (m) => m.name == j['authMode'],
      orElse: () => MachineAuthMode.managed,
    ),
    engine: j['engine'] as String?,
    name: j['name'] as String?,
    hostname: j['hostname'] as String?,
    status: j['status'] as String?,
  );

  Machine copyWith({String? name}) => Machine(
    machineId: machineId,
    apiKey: apiKey,
    computerId: computerId,
    authMode: authMode,
    engine: engine,
    name: name ?? this.name,
    hostname: hostname,
    status: status,
  );
}

/// Data-plane agent (RPC agents_list).
class Agent {
  final String id;
  final String? sessionId;
  final String name;
  final String? engine;
  final String? engineDisplayName;
  final String? engineIconHint;
  final String? codexHome;
  final String? parentAgentId;
  final String status;
  final String launchState;
  final String? launchError;
  final String? launchDetail;
  final bool terminalAvailable;
  final String? terminalUnavailableReason;

  const Agent({
    required this.id,
    this.sessionId,
    required this.name,
    this.engine,
    this.engineDisplayName,
    this.engineIconHint,
    this.codexHome,
    this.parentAgentId,
    this.status = 'active',
    this.launchState = 'ready',
    this.launchError,
    this.launchDetail,
    this.terminalAvailable = false,
    this.terminalUnavailableReason,
  });

  factory Agent.fromJson(Map<String, dynamic> j) {
    final terminal = j['terminal'];
    final terminalMap = terminal is Map
        ? Map<String, dynamic>.from(terminal)
        : const <String, dynamic>{};
    final runtimes = terminalMap['runtimes'] is List
        ? terminalMap['runtimes'] as List
        : const [];
    final hasTmux = runtimes.any(
      (runtime) => runtime is Map && runtime['backend'] == 'tmux',
    );
    final advertisedAvailable = terminalMap['available'];
    final terminalAvailable = advertisedAvailable is bool
        ? advertisedAvailable
        : hasTmux;
    final launchRaw = j['launch'];
    final launch = launchRaw is Map
        ? Map<String, dynamic>.from(launchRaw)
        : const <String, dynamic>{};
    final launchState = switch (launch['state']) {
      'starting' => 'starting',
      'failed' => 'failed',
      _ => 'ready',
    };
    return Agent(
      id: j['id'] as String,
      sessionId: _safeLabel(j['sessionId']),
      name: j['name'] as String? ?? 'agent',
      engine: _safeEngine(j['engine']),
      engineDisplayName: _safeLabel(j['engineDisplayName']),
      engineIconHint: _safeLabel(j['engineIconHint']),
      codexHome: j['engine'] == 'codex' ? _safeCodexHome(j['codexHome']) : null,
      parentAgentId: _safeLabel(j['parentAgentId'] ?? j['parentId']),
      status: (j['status'] as String?) ?? 'active',
      launchState: launchState,
      launchError: launchState == 'failed' ? _safeLabel(launch['error']) : null,
      launchDetail: launchState == 'failed'
          ? _safeDetail(launch['detail'])
          : null,
      terminalAvailable: terminalAvailable,
      terminalUnavailableReason: terminalAvailable
          ? null
          : _safeLabel(terminalMap['reason']) ??
                'terminal unavailable (no verified terminal pane)',
    );
  }

  Agent copyWith({String? name}) => Agent(
    id: id,
    sessionId: sessionId,
    name: name ?? this.name,
    engine: engine,
    engineDisplayName: engineDisplayName,
    engineIconHint: engineIconHint,
    codexHome: codexHome,
    parentAgentId: parentAgentId,
    status: status,
    launchState: launchState,
    launchError: launchError,
    launchDetail: launchDetail,
    terminalAvailable: terminalAvailable,
    terminalUnavailableReason: terminalUnavailableReason,
  );

  static String? _safeEngine(Object? raw) {
    if (raw is! String || raw.isEmpty || raw.length > 64) return null;
    return RegExp(r'^[a-zA-Z0-9._-]+$').hasMatch(raw) ? raw : null;
  }

  static String? _safeCodexHome(Object? raw) {
    if (raw is! String ||
        !raw.startsWith('/') ||
        raw.length > 4096 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(raw)) {
      return null;
    }
    return raw;
  }

  static String? _safeLabel(Object? raw) {
    if (raw is! String || raw.isEmpty) return null;
    return raw.length <= 80 ? raw : raw.substring(0, 80);
  }

  static String? _safeDetail(Object? raw) {
    if (raw is! String || raw.isEmpty) return null;
    final clean = raw.replaceAll(RegExp(r'[\u0000-\u001f\u007f]'), ' ').trim();
    if (clean.isEmpty) return null;
    return clean.length <= 500 ? clean : clean.substring(0, 500);
  }
}

/// What the daemon answered when asked where a typed task belongs (⌘B).
///
/// `candidates` is the pick followed by EVERY other agent the daemon weighed — ranked where the router
/// ranked them, in rail order after that. Not a shortlist: when the router is unsure the right agent is
/// often the one it put fourth, and a picker that cannot show it leaves no way forward but Esc.
/// The window reads it only when `confidence` is too low to act on — the whole point of the number
/// being on the wire.
class RouteAnswer {
  const RouteAnswer({
    required this.agentId,
    required this.machineId,
    required this.name,
    required this.confidence,
    required this.reason,
    required this.candidates,
    this.weighed = 0,
    this.machines = 0,
    this.via = '',
  });

  final String agentId;

  /// Which computer the pick lives on. Names are for reading; this is what opens the pane.
  final String machineId;
  final String name;
  final double confidence;
  final String reason;
  final List<RouteCandidate> candidates;

  /// How many agents were weighed, and across how many computers.
  ///
  /// Shown WHILE the router thinks, because the question during those seconds is not "how long" — it is
  /// "did it even look at the agent I mean". The daemon caps the list it weighs, so this is the only
  /// place that can answer it.
  final int weighed;
  final int machines;

  /// 'model' when a classifier answered, 'heuristic' when name matching stood in for it, '' when the
  /// daemon did not say.
  ///
  /// Both land under the threshold BY DESIGN — an unsure model and a router that could not run must both
  /// stop and ask — which is exactly why the window needs to tell them apart: "not sure which agent" and
  /// "the router could not run" send a person to different next moves.
  final String via;

  /// True when nobody was picked at all — an empty machine, or a daemon that could not answer.
  bool get isEmpty => agentId.isEmpty;

  /// Read with `is`, never with `as`.
  ///
  /// `json['x'] as String?` does not answer null for a number — it THROWS, and this frame crosses a
  /// socket, so the shape is whatever the other end sent. An exception here surfaces as a palette
  /// spinner that never comes down, which is the one failure the person cannot act on. A malformed field
  /// has to read as "nobody was picked" instead.
  static RouteAnswer fromJson(Map<String, dynamic> json) => RouteAnswer(
    agentId: _str(json['agentId']),
    machineId: _str(json['machineId']),
    name: _str(json['name']),
    confidence: json['confidence'] is num
        ? (json['confidence'] as num).toDouble()
        : 0,
    reason: _str(json['reason']),
    weighed: json['weighed'] is num ? (json['weighed'] as num).toInt() : 0,
    machines: json['machines'] is num ? (json['machines'] as num).toInt() : 0,
    via: _str(json['via']),
    candidates: [
      for (final entry
          in (json['candidates'] is List
              ? json['candidates'] as List<dynamic>
              : const []))
        if (entry is Map<String, dynamic>) RouteCandidate.fromJson(entry),
    ],
  );
}

class RouteCandidate {
  const RouteCandidate({
    required this.agentId,
    required this.machineId,
    required this.name,
    required this.machine,
    required this.recent,
    this.engine = '',
    this.confidence = 0,
  });

  final String agentId;

  /// Which computer to open the pane on. Names are for reading; this is for acting.
  final String machineId;
  final String name;

  /// Which computer it runs on. The candidate list spans every machine, so two agents named "api" on two
  /// of them are the same row twice without this.
  final String machine;

  /// What that agent was last doing — the line under its name when the window has to ask.
  final String recent;

  /// Which CLI it runs on. The picker wears the same engine mark the rail does, so a row here and the
  /// same agent in the rail are recognisably one thing rather than two lists that happen to share names.
  final String engine;

  /// How well the router thought this one fits, 0..1. DISPLAY ONLY.
  ///
  /// Nothing is dispatched on it — the pick is [RouteAnswer.agentId] and the number that gates it is
  /// [RouteAnswer.confidence]. 0 means the router said nothing about this candidate, and the picker
  /// draws no bar rather than an empty one, because an empty bar reads as "no fit" and this is "no
  /// answer".
  final double confidence;

  static RouteCandidate fromJson(Map<String, dynamic> json) => RouteCandidate(
    agentId: _str(json['agentId']),
    machineId: _str(json['machineId']),
    name: _str(json['name']),
    machine: _str(json['machine']),
    recent: _str(json['recent']),
    engine: _str(json['engine']),
    confidence: json['confidence'] is num
        ? (json['confidence'] as num).toDouble().clamp(0, 1)
        : 0,
  );
}

String _str(Object? value) => value is String ? value : '';
