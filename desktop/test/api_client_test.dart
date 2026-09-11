import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('machine request hits the local CLI proxy, not the backend, with no credential', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final path = Completer<String?>();
    final hadAuthHeader = Completer<bool>();
    final subscription = server.listen((request) async {
      path.complete(request.uri.path);
      hadAuthHeader.complete(request.headers.value('authorization') != null);
      request.response
        ..statusCode = HttpStatus.ok
        ..headers.contentType = ContentType.json
        ..write(
          jsonEncode({
            'success': true,
            'data': {
              'machines': [
                {
                  'machineId': 'machine-1',
                  'computerId': '0123456789abcdef0123456789abcdef',
                  'authMode': 'remote',
                  'status': 'online',
                },
              ],
            },
          }),
        );
      await request.response.close();
    });

    try {
      final api = ApiClient(
        config: AppConfig(
          apiBaseUrl: 'http://unused.invalid',
          localCliBaseUrl: 'http://127.0.0.1:${server.port}',
        ),
        session: AuthSession(),
      );
      final machines = await api.machines();

      expect(await path.future, '/api/machines');
      expect(await hadAuthHeader.future, isFalse);
      expect(machines.single.machineId, 'machine-1');
      expect(machines.single.computerId, '0123456789abcdef0123456789abcdef');
    } finally {
      await subscription.cancel();
      await server.close(force: true);
    }
  });
}
