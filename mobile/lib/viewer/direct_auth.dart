import '../api/access_token_source.dart';
import '../auth/auth_session.dart';
import 'direct_auth_api.dart';

/// A viewer build's SSO session — authSession.ts's `AuthSessionManager`, moved into the app because
/// a device with no harness CLI has nobody else to hold it: the tokens `/api/auth/exchange` issued,
/// kept in [AuthSession], refreshed [_refreshSkew] before they lapse, one refresh at a time.
class DirectAuth implements AccessTokenSource {
  DirectAuth({required this.session, required this.api});

  final AuthSession session;
  final DirectAuthApi api;
  Future<String>? _refreshing;

  static const _refreshSkew = Duration(seconds: 60);

  Future<bool> hasSession() async =>
      ((await session.accessToken()) ?? '').isNotEmpty;

  Future<void> signIn(IssuedTokens tokens) => session.saveLogin(
    token: tokens.token,
    refreshToken: tokens.refreshToken,
    autonomousEnv: tokens.autonomousEnv ?? api.config.autonomousEnv,
    expiresIn: tokens.expiresIn,
  );

  Future<void> signOut() => session.clear();

  @override
  Future<String> accessToken({bool force = false, String? failedToken}) async {
    // Token and expiry in one read: every WebSocket dial comes through here, and
    // the two of them live in the same file behind the same exclusive lock, so
    // asking separately doubled the disk work on the one call the launch and
    // every reconnect wait on. See [AuthSession.accessTokenWithExpiry].
    final saved = await session.accessTokenWithExpiry();
    final current = saved.token;
    if (current == null || current.isEmpty) {
      throw const DirectAuthException('Not signed in.', signedOut: true);
    }
    // Someone else already refreshed past the token that failed — use theirs.
    if (failedToken != null && failedToken != current) return current;
    if (!force && !_isStale(saved.expiresAt)) return current;
    return _refreshing ??= _refresh().whenComplete(() => _refreshing = null);
  }

  /// A token with no recorded expiry is taken at face value: it is what a
  /// session saved by a build that did not store one looks like, and refusing it
  /// would sign that user out for no reason. A server rejection still routes
  /// through `failedToken` above.
  bool _isStale(DateTime? expiresAt) =>
      expiresAt != null &&
      expiresAt.isBefore(DateTime.now().toUtc().add(_refreshSkew));

  Future<String> _refresh() async {
    final refreshToken = await session.refreshToken();
    if (refreshToken == null || refreshToken.isEmpty) {
      await session.clear();
      throw const DirectAuthException(
        'Your sign-in expired. Sign in again.',
        signedOut: true,
      );
    }
    try {
      final autonomousEnv = await session.autonomousEnv();
      final tokens = await api.refresh(refreshToken, autonomousEnv: autonomousEnv);
      await session.saveRefresh(
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        autonomousEnv: autonomousEnv,
        expiresIn: tokens.expiresIn,
      );
      return tokens.token;
    } on DirectAuthException catch (error) {
      if (error.signedOut) await session.clear();
      rethrow;
    }
  }
}
