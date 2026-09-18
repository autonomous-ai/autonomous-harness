import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';

/// Persists the SSO access + refresh tokens in the Desktop Harness state file.
class AuthSession {
  final LocalKeyValueStore _storage;
  static const _access = 'auth_access_token';
  static const _refresh = 'auth_refresh_token';
  static const _env = 'auth_autonomous_env';
  static const _expiresAt = 'auth_access_token_expires_at';

  AuthSession({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared;

  /// Store a newly authenticated session. A missing refresh token clears any
  /// stale token left by a previous account/environment.
  Future<void> saveLogin({
    required String token,
    String? refreshToken,
    String autonomousEnv = 'prod',
    int? expiresIn,
  }) async {
    await _storage.write(_access, token);
    if (refreshToken != null && refreshToken.isNotEmpty) {
      await _storage.write(_refresh, refreshToken);
    } else {
      await _storage.delete(_refresh);
    }
    await _storage.write(_env, autonomousEnv);
    await _saveExpiry(expiresIn);
  }

  /// Store a refreshed access token. Identity providers do not always rotate
  /// the refresh token, so retain the current one when it is omitted.
  Future<void> saveRefresh({
    required String token,
    String? refreshToken,
    required String autonomousEnv,
    int? expiresIn,
  }) async {
    await _storage.write(_access, token);
    if (refreshToken != null && refreshToken.isNotEmpty) {
      await _storage.write(_refresh, refreshToken);
    }
    await _storage.write(_env, autonomousEnv);
    await _saveExpiry(expiresIn);
  }

  Future<String?> accessToken() => _storage.read(_access);
  Future<String?> refreshToken() => _storage.read(_refresh);
  Future<String> autonomousEnv() async => (await _storage.read(_env)) ?? 'prod';
  Future<DateTime?> accessTokenExpiresAt() async =>
      _expiryFrom(await _storage.read(_expiresAt));

  /// The token and its expiry as ONE read.
  ///
  /// The launch asks both questions back to back — is there a session, and is it
  /// still good — and asking them separately costs two exclusive locks on
  /// `state.json` and two full parses of it (see [HarnessFileStore]), in series,
  /// before the app can so much as decide which screen to show.
  ///
  /// Reading them together also makes the pair coherent: taken separately, a
  /// refresh landing between the two reads returns the OLD token with the NEW
  /// expiry — a token that then looks fresh and is not, which is a sign-in
  /// failure several round-trips later rather than a refresh here.
  Future<({String? token, DateTime? expiresAt})> accessTokenWithExpiry() async {
    final saved = await _storage.readMany([_access, _expiresAt]);
    return (
      token: saved[_access],
      expiresAt: _expiryFrom(saved[_expiresAt]),
    );
  }

  static DateTime? _expiryFrom(String? raw) {
    final milliseconds = int.tryParse(raw ?? '');
    return milliseconds == null
        ? null
        : DateTime.fromMillisecondsSinceEpoch(milliseconds, isUtc: true);
  }

  Future<void> _saveExpiry(int? expiresIn) async {
    if (expiresIn == null || expiresIn <= 0) {
      await _storage.delete(_expiresAt);
      return;
    }
    final expiresAt = DateTime.now().toUtc().add(Duration(seconds: expiresIn));
    await _storage.write(
      _expiresAt,
      expiresAt.millisecondsSinceEpoch.toString(),
    );
  }

  Future<void> clear() async {
    await _storage.delete(_access);
    await _storage.delete(_refresh);
    await _storage.delete(_env);
    await _storage.delete(_expiresAt);
  }
}
