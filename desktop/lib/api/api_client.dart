import 'package:dio/dio.dart';

import '../auth/auth_session.dart';
import '../core/config.dart';
import '../core/models.dart';
import '../logging/http_log.dart';

/// Control-plane REST client. Every call here goes to the LOCAL `harness` CLI
/// (loopback, no credential — see CLAUDE.md's naming/architecture notes for why), which proxies to
/// the real backend using its own saved SSO session. This app never holds a bearer token itself.
/// Terminal bytes ride the local WS path (relayed transparently for non-local machines).
class ApiClient {
  final AppConfig config;
  final AuthSession session;
  late final Dio _dio = attachHttpLog(
    Dio(
      BaseOptions(
        baseUrl: config.localCliBaseUrl,
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 30),
        // Let the API wrapper turn HTTP failures into short, user-facing
        // ApiExceptions. Transport failures still surface as DioExceptions.
        validateStatus: (status) =>
            status != null && status >= 200 && status < 600,
      ),
    ),
  );

  ApiClient({required this.config, required this.session});

  dynamic _unwrap(Response res) {
    final body = res.data;
    if (body is Map && body['success'] == true) {
      return body['data'];
    }
    final error = body is Map ? body['error'] : null;
    final serverMessage = error is Map ? error['message'] : null;
    throw ApiException(
      serverMessage is String && serverMessage.isNotEmpty
          ? serverMessage
          : 'Request failed (${res.statusCode})',
      status: res.statusCode,
    );
  }

  // -- auth (proxied by the local CLI — no credential on this leg) --
  Future<Map<String, dynamic>?> me() async {
    final res = await _dio.get('/api/auth/me');
    return _unwrap(res) as Map<String, dynamic>?;
  }

  // -- machines (control plane, proxied by the local CLI) --
  Future<List<Machine>> machines() async {
    final res = await _dio.get('/api/machines');
    final data = _unwrap(res) as Map<String, dynamic>;
    final list = data['machines'] as List<dynamic>? ?? [];
    return list
        .map((e) => Machine.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<String?> renameMachine({
    required String machineId,
    required String name,
  }) async {
    final res = await _dio.patch(
      '/api/machines/$machineId',
      data: {'name': name},
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    final data = _unwrap(res) as Map<String, dynamic>;
    return data['name'] as String?;
  }

  Future<void> deleteMachine({required String machineId}) async {
    final res = await _dio.delete(
      '/api/machines/$machineId',
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    _unwrap(res);
  }
}

class ApiException implements Exception {
  final String message;
  final int? status;
  ApiException(this.message, {this.status});
  @override
  String toString() => message;
}

bool isUnauthorizedError(Object error) =>
    error is DioException && error.response?.statusCode == 401 ||
    error is ApiException && error.status == 401;
