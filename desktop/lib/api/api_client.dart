import 'package:dio/dio.dart';

import '../auth/auth_session.dart';
import '../core/config.dart';
import '../core/models.dart';
import '../logging/http_log.dart';
import 'access_token_source.dart';
import 'bearer_auth_interceptor.dart';

/// Control-plane REST client.
///
/// In a desktop build every call goes to the LOCAL `harness` CLI (loopback, no credential — see
/// CLAUDE.md's naming/architecture notes for why), which proxies to the real backend using its own
/// saved SSO session, and this app never holds a bearer token itself. A viewer build has no CLI:
/// given [auth], the same calls go straight to the backend, signed with the session the app holds.
/// Terminal bytes ride the WS path either way.
class ApiClient {
  final AppConfig config;
  final AuthSession session;
  final AccessTokenSource? auth;
  late final Dio _dio = _buildDio();

  ApiClient({required this.config, required this.session, this.auth});

  Dio _buildDio() {
    final dio = attachHttpLog(
      Dio(
        BaseOptions(
          baseUrl: auth == null ? config.localCliBaseUrl : config.apiBaseUrl,
          connectTimeout: const Duration(seconds: 15),
          receiveTimeout: const Duration(seconds: 30),
          // Let the API wrapper turn HTTP failures into short, user-facing
          // ApiExceptions. Transport failures still surface as DioExceptions.
          validateStatus: (status) =>
              status != null && status >= 200 && status < 600,
        ),
      ),
    );
    final source = auth;
    if (source != null) {
      dio.interceptors.add(
        BearerAuthInterceptor(source, dio, autonomousEnv: config.autonomousEnv),
      );
    }
    return dio;
  }

  // -- auth (proxied by the local CLI — no credential on this leg) --
  Future<Map<String, dynamic>?> me() async {
    final res = await _dio.get('/api/auth/me');
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  // -- the Harness Store: ratings and reviews (control plane, proxied by the local CLI) --
  Future<Map<String, dynamic>?> storeRatings() async {
    final res = await _dio.get('/api/store/ratings');
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  Future<Map<String, dynamic>?> storeReviews(String harnessId) async {
    final res = await _dio.get('/api/store/harnesses/$harnessId/reviews');
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  /// Write (or rewrite) the signed-in person's review of [harnessId].
  Future<Map<String, dynamic>?> putStoreReview(
    String harnessId, {
    required int rating,
    String? title,
    String? body,
  }) async {
    final res = await _dio.put(
      '/api/store/harnesses/$harnessId/review',
      data: {
        'rating': rating,
        if (title != null && title.trim().isNotEmpty) 'title': title.trim(),
        if (body != null && body.trim().isNotEmpty) 'body': body.trim(),
      },
      // The CLI accepts a write only from this app on this computer, as it does
      // for renaming a machine. Without the header every review was refused
      // with 403, which the store worded as "Sign in".
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    return unwrapApiResponse(res) as Map<String, dynamic>?;
  }

  Future<void> deleteStoreReview(String harnessId) async {
    final res = await _dio.delete(
      '/api/store/harnesses/$harnessId/review',
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    unwrapApiResponse(res);
  }

  // -- machines (control plane, proxied by the local CLI) --
  /// Whether the last [machines] answer came from the daemon's cache rather than the backend.
  ///
  /// The daemon answers 200 with the last known-good list when the backend leg is unreachable, so a
  /// caller that only checked the status code would mistake an outage for a healthy, current read.
  bool lastMachinesStale = false;
  List<Machine> _sharedMachines = [];

  Future<List<Machine>> machines() async {
    final res = await _dio.get('/api/machines');
    final data = unwrapApiResponse(res) as Map<String, dynamic>;
    lastMachinesStale = data['stale'] == true;
    final list = data['machines'] as List<dynamic>? ?? [];
    final owned = list
        .map((e) => Machine.fromJson(e as Map<String, dynamic>))
        .toList();
    try {
      final shared = await _dio.get('/api/harness-shares');
      if (shared.statusCode == 404) {
        _sharedMachines = [];
      } else {
        final body = unwrapApiResponse(shared) as Map<String, dynamic>;
        _sharedMachines = [
          for (final row in body['machines'] as List? ?? const [])
            Machine.fromJson(Map<String, dynamic>.from(row as Map)),
        ];
      }
    } catch (error) {
      if (isUnauthorizedError(error)) rethrow;
      lastMachinesStale = true;
    }
    return [
      ...owned,
      ..._sharedMachines.where(
        (shared) => !owned.any((own) => own.machineId == shared.machineId),
      ),
    ];
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
    final data = unwrapApiResponse(res) as Map<String, dynamic>;
    return data['name'] as String?;
  }

  Future<void> deleteMachine({required String machineId}) async {
    final res = await _dio.delete(
      '/api/machines/$machineId',
      options: Options(headers: {'x-adapter-local': '1'}),
    );
    unwrapApiResponse(res);
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

/// Unwraps the backend's `{success, data, error}` envelope, which both legs
/// speak: the CLI's loopback server mirrors it, and the viewer's own auth calls
/// (`viewer/direct_auth_api.dart`) read it straight from the backend.
dynamic unwrapApiResponse(Response res) {
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

/// The local daemon can answer normally while its separate backend request fails.
/// Those gateway errors need recovery just as a broken loopback connection does.
bool isTransientApiError(Object error) {
  if (error is ApiException) {
    return const {502, 503, 504}.contains(error.status);
  }
  return error is DioException &&
      const {
        DioExceptionType.connectionError,
        DioExceptionType.connectionTimeout,
        DioExceptionType.sendTimeout,
        DioExceptionType.receiveTimeout,
      }.contains(error.type);
}

/// The sentence a failed local-CLI call earns on an error strip. A raw
/// `DioException` is a paragraph about `RequestOptions.receiveTimeout` — true,
/// and useless to the person reading it: what they need is which leg failed.
/// The daemon not listening, the daemon not answering (it proxies to the
/// backend, so that is nearly always the backend being slow), or the backend
/// answering with a sentence of its own, which the daemon forwards verbatim.
String describeApiError(Object error) {
  if (error is ApiException) return error.message;
  if (error is DioException) {
    switch (error.type) {
      case DioExceptionType.connectionError:
        return 'the local Harness service is not answering on its port. '
            'It usually restarts on its own; retry in a moment.';
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
        final limit = error.requestOptions.receiveTimeout?.inSeconds;
        return 'the local Harness service did not answer'
            '${limit == null ? '' : ' within ${limit}s'} — the Harness '
            'backend is probably slow right now. Retry in a moment.';
      case DioExceptionType.badResponse:
        return 'the local Harness service answered '
            '${error.response?.statusCode ?? 'with an error'}.';
      case DioExceptionType.badCertificate:
      case DioExceptionType.cancel:
      case DioExceptionType.transformTimeout:
      case DioExceptionType.unknown:
        return error.message ?? error.error?.toString() ?? 'request failed';
    }
  }
  return '$error';
}
