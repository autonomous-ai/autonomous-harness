import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('machine request hits the local CLI proxy, not the backend, with no credential', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final paths = <String>[];
    final hadAuthHeaders = <bool>[];
    final subscription = server.listen((request) async {
      paths.add(request.uri.path);
      hadAuthHeaders.add(request.headers.value('authorization') != null);
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

      expect(paths, ['/api/machines', '/api/harness-shares']);
      expect(hadAuthHeaders, [false, false]);
      expect(machines.single.machineId, 'machine-1');
      expect(machines.single.computerId, '0123456789abcdef0123456789abcdef');
    } finally {
      await subscription.cancel();
      await server.close(force: true);
    }
  });

  test('review writes carry the local header the CLI requires; reads do not need it', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final seen = <(String, String, String?)>[];
    final subscription = server.listen((request) async {
      seen.add((
        request.method,
        request.uri.path,
        request.headers.value('x-adapter-local'),
      ));
      await utf8.decoder.bind(request).join();
      request.response
        ..statusCode = HttpStatus.ok
        ..headers.contentType = ContentType.json
        ..write(
          jsonEncode({
            'success': true,
            'data': {'ok': true},
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
      await api.storeRatings();
      await api.putStoreReview('autonomous/typst', rating: 5, title: ' Great ');
      await api.deleteStoreReview('autonomous/typst');
      expect(seen, [
        ('GET', '/api/store/ratings', null),
        ('PUT', '/api/store/harnesses/autonomous/typst/review', '1'),
        ('DELETE', '/api/store/harnesses/autonomous/typst/review', '1'),
      ]);
    } finally {
      await subscription.cancel();
      await server.close(force: true);
    }
  });

  test('shared discovery keeps offline grants through outages, clears revoked entries and supports older daemons', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var shareStatus = 200;
    var shares = <Map<String, dynamic>>[
      {
        'machineId': 'shared',
        'shared': true,
        'authMode': 'remote',
        'status': 'offline',
        'ownerName': 'D',
        'name': 'Studio',
        'shares': [
          {
            'id': 'grant',
            'agentId': 'agent',
            'name': 'Climate dashboard',
            'engine': 'codex',
            'expiresAt': '2027-01-01T00:00:00Z',
          },
        ],
      },
      {
        'machineId': 'owned',
        'shared': true,
        'authMode': 'remote',
        'shares': [],
      },
    ];
    server.listen((request) async {
      final sharing = request.uri.path == '/api/harness-shares';
      request.response.statusCode = sharing ? shareStatus : 200;
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'success': shareStatus == 200 || !sharing,
          'data': {
            'machines': sharing
                ? shares
                : [
                    {
                      'machineId': 'owned',
                      'authMode': 'remote',
                      'name': 'This computer',
                    },
                  ],
          },
          'error': {'code': 'UNAVAILABLE', 'message': 'Temporary outage'},
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
      final first = await api.machines();
      expect(first.map((m) => m.machineId), ['owned', 'shared']);
      final shared = first.last;
      expect(shared.isShared, isTrue);
      expect(shared.status, 'offline');
      expect(shared.ownerName, 'D');
      expect(shared.sharedHarnesses.single.agentId, 'agent');
      expect(
        shared.copyWith(name: 'Updated').sharedHarnesses.single.id,
        'grant',
      );
      shareStatus = 503;
      expect((await api.machines()).last.machineId, 'shared');
      expect(api.lastMachinesStale, isTrue);
      shareStatus = 200;
      shares = [];
      expect((await api.machines()).map((m) => m.machineId), ['owned']);
      expect(api.lastMachinesStale, isFalse);
      shareStatus = 404;
      expect((await api.machines()).single.machineId, 'owned');
      expect(api.lastMachinesStale, isFalse);
      shareStatus = 401;
      await expectLater(api.machines(), throwsA(isA<ApiException>()));
    } finally {
      await server.close(force: true);
    }
  });

  group('describeApiError', () {
    final options = RequestOptions(
      path: '/api/machines',
      receiveTimeout: const Duration(seconds: 30),
    );
    test('names the leg that failed instead of quoting Dio', () {
      expect(
        describeApiError(
          DioException(
            requestOptions: options,
            type: DioExceptionType.receiveTimeout,
            message:
                'The request took longer than 0:00:30.000000 to receive data.',
          ),
        ),
        'the local Harness service did not answer within 30s — the Harness '
        'backend is probably slow right now. Retry in a moment.',
      );
      expect(
        describeApiError(
          DioException(
            requestOptions: options,
            type: DioExceptionType.connectionError,
          ),
        ),
        startsWith('the local Harness service is not answering on its port.'),
      );
    });
    test(
      'passes the backend sentence the daemon forwarded straight through',
      () {
        expect(
          describeApiError(
            ApiException(
              'The Harness backend did not answer GET /api/machines within 20s. Try again in a moment.',
              status: 504,
            ),
          ),
          'The Harness backend did not answer GET /api/machines within 20s. Try again in a moment.',
        );
        expect(describeApiError(StateError('odd')), 'Bad state: odd');
      },
    );
  });

  test('only transient connection and gateway errors qualify for recovery', () {
    for (final status in [502, 503, 504]) {
      expect(
        isTransientApiError(ApiException('unavailable', status: status)),
        isTrue,
      );
    }
    for (final status in [400, 401, 403, 404]) {
      expect(
        isTransientApiError(ApiException('refused', status: status)),
        isFalse,
      );
    }
    final options = RequestOptions(path: '/api/machines');
    expect(
      isTransientApiError(
        DioException(
          requestOptions: options,
          type: DioExceptionType.connectionTimeout,
        ),
      ),
      isTrue,
    );
    expect(
      isTransientApiError(
        DioException(requestOptions: options, type: DioExceptionType.cancel),
      ),
      isFalse,
    );
    expect(isTransientApiError(StateError('invalid response')), isFalse);
  });
}
