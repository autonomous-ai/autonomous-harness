import 'dart:convert';
import 'dart:typed_data';

import 'bytes.dart';
import 'primitives.dart';

/// core.ts's frame-payload envelope: `{__e2e: {v, k, n, ct, epoch?}}` stands in for a frame's
/// payload while its `type` stays readable, so the relay can route what it cannot read.

const int e2eVersion = 1;

/// Frames this client must send as ciphertext — core.ts `ENCRYPTED_DOWN_TYPES`. test/e2ee/ holds it
/// to the CLI's own list, because a type missing here fails nowhere: the frame simply leaves in the
/// clear, and for terminal_* the relay then drops it as TERMINAL_FRAME_REJECTED.
const Set<String> encryptedDownTypes = {
  // Harness's application RPC extensions (CLI e2ee/applicationFrames.ts).
  'grid_fleet_capabilities',
  'grid_fleet_run',
  'grid_fleet_cancel',
  'message',
  'question_response',
  'agents_list',
  'sessions_list',
  'session_get',
  'models_list',
  'agent_create',
  'agent_create_status',
  'agent_delete',
  'agent_restart',
  'agent_recent',
  'agent_update',
  'agent_files',
  'agent_read_file',
  'fs_list_dir',
  'project_preview',
  'codex_profiles_list',
  'codex_profile_link',
  // Asks the machine to read its OWN agent accounts' usage (cli/src/lib/accountUsage.ts). Missing
  // here it went out in the clear and the machine's CLI refused it outright with E2EE_REQUIRED —
  // which surfaced as an empty Usage page on a phone that was linked and connected.
  'usage_read',
  // The pane colours this client paints with, for the machine's tmux sessions (cli/src/lib/hostTheme.ts).
  'theme_set',
  'device_e2ee_pair',
  'e2ee_pairings_list',
  'e2ee_pairing_unpair',
  'e2ee_pairings_unpair_all',
  'e2ee_browser_link_create',
  'terminal_capabilities',
  'terminal_open',
  'terminal_alive',
  'terminal_ack',
  'terminal_input',
  'terminal_resize',
  'terminal_resync',
  'terminal_close',
  'terminal_scroll',
  'terminal_chunked_upload_begin',
  'terminal_chunked_upload_cancel',
  'p2p_offer',
  'p2p_answer',
  'p2p_ice_candidate',
  'p2p_abort',
  'p2p_promote',
};

Uint8List _aad(int v, String type, String dbSessionId, String k, String epoch) =>
    utf8Bytes('$v|$type|$dbSessionId|$k|$epoch');

/// Seals [payload] under [key]: [k] is 'p' (pairwise session) or 'g' (the machine's group key,
/// which also carries an [epoch]).
Map<String, Object?> wrapPayload(
  List<int> key,
  String k,
  int counter,
  String frameType,
  String? dbSessionId,
  Object? payload, {
  String? epoch,
}) {
  final aad = _aad(e2eVersion, frameType, dbSessionId ?? '', k, epoch ?? '');
  final sealed = aeadSeal(key, counter, aad, utf8Bytes(jsonEncode(payload)));
  return {
    '__e2e': {
      'v': e2eVersion,
      'k': k,
      'n': counter,
      'ct': b64e(sealed),
      'epoch': ?epoch,
    },
  };
}

/// The payload object [wrapPayload] sealed; null when it does not open — a wrong key or counter, or
/// an AAD (type, session, epoch) other than the one it was sealed under.
Map<String, dynamic>? unwrapPayload(
  List<int> key,
  Map<String, dynamic> env,
  String frameType,
  String? dbSessionId,
) {
  final v = env['v'], k = env['k'], n = env['n'], ct = env['ct'];
  final epoch = env['epoch'] ?? '';
  if (v is! int || k is! String || n is! int || ct is! String || epoch is! String) {
    return null;
  }
  final Uint8List sealed;
  try {
    sealed = b64d(ct);
  } on FormatException {
    return null;
  }
  final clear = aeadOpen(key, n, _aad(v, frameType, dbSessionId ?? '', k, epoch), sealed);
  return clear == null ? null : jsonObjectOf(clear);
}

bool isWrapped(Object? payload) => payload is Map && payload.containsKey('__e2e');

/// UTF-8 JSON that must be an object; null for anything else.
Map<String, dynamic>? jsonObjectOf(List<int> utf8Json) {
  try {
    final value = jsonDecode(utf8.decode(utf8Json));
    return value is Map<String, dynamic> ? value : null;
  } on FormatException {
    return null;
  }
}
