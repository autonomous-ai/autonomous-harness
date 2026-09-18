import 'dart:async';
import 'dart:io';

import '../auth/cli_login.dart';
import '../auth/sign_in_client.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';

/// Signing in with no harness CLI — cli.ts `loginCommand`, run by the app: a loopback listener for
/// the SSO redirect, `authorize-native` for the page to show, `exchange` for the tokens.
///
/// It deliberately skips the CLI's closing `resolve-computer`, which registers the computer as a
/// Harness machine. A viewer is not one.
class DirectLogin implements SignInClient {
  DirectLogin({required this.auth});

  final DirectAuth auth;
  _LoopbackCallback? _pending;

  static const _callbackTimeout = Duration(minutes: 5);

  @override
  Future<CliAuthStatus> checkStatus() async =>
      CliAuthStatus(loggedIn: await auth.hasSession());

  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
  }) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final callback = _pending = _LoopbackCallback(server);
    try {
      final start = await auth.api.authorizeNative(
        'http://127.0.0.1:${server.port}/callback',
      );
      onAuthorizeUrl(start.authorizeUrl);
      final redirect = await callback.result.timeout(
        _callbackTimeout,
        onTimeout: () => throw const DirectAuthException('Sign-in timed out.'),
      );
      await auth.signIn(
        await auth.api.exchange(
          code: redirect.code,
          state: redirect.state,
          tx: start.tx,
        ),
      );
    } finally {
      _pending = null;
      await server.close(force: true);
    }
  }

  @override
  void cancel() => _pending?.cancel();

  @override
  Future<void> logout() => auth.signOut();
}

/// The loopback end of the redirect: the first `/callback` carrying `code` and `state` completes
/// it and an `error` fails it; anything else the browser asks for (a favicon) is turned away.
class _LoopbackCallback {
  _LoopbackCallback(HttpServer server) {
    server.listen(_onRequest);
  }

  final _completer = Completer<({String code, String state})>();

  Future<({String code, String state})> get result => _completer.future;

  Future<void> _onRequest(HttpRequest request) async {
    final response = request.response;
    if (request.uri.path != '/callback') {
      response.statusCode = HttpStatus.notFound;
      await response.close();
      return;
    }
    final query = request.uri.queryParameters;
    final code = query['code'], state = query['state'], error = query['error'];
    final signedIn = error == null && code != null && state != null;
    response
      ..statusCode = signedIn ? HttpStatus.ok : HttpStatus.badRequest
      ..headers.contentType = ContentType.html
      ..write(
        _page(
          signedIn ? 'Signed in to OpenHarness' : 'OpenHarness sign-in failed',
        ),
      );
    await response.close();
    if (_completer.isCompleted) return;
    if (signedIn) {
      _completer.complete((code: code, state: state));
    } else {
      _completer.completeError(
        DirectAuthException('Sign-in failed: ${error ?? 'no code returned'}'),
      );
    }
  }

  void cancel() {
    if (_completer.isCompleted) return;
    _completer.completeError(
      const DirectAuthException('Sign-in was cancelled.'),
    );
  }
}

String _page(String title) =>
    '<!doctype html><meta charset="utf-8"><title>$title</title>'
    '<body style="font:16px system-ui,sans-serif;text-align:center;padding:4em 1em">'
    '<h1 style="font-weight:600">$title</h1>'
    '<p>You can close this window and go back to OpenHarness.</p></body>';
