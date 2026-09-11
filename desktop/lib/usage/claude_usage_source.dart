import 'package:dio/dio.dart';

import '../logging/http_log.dart';
import 'usage_account_key.dart';
import 'usage_credentials.dart';
import 'usage_source.dart';
import 'usage_window.dart';

/// Claude Code's rate limits, read with the token `claude login` left behind.
///
/// ⚠️ **This endpoint is undocumented.** It is what the CLI itself asks when it
/// prints `/usage`, and it answers only to a token minted for the CLI — hence
/// the beta header and the CLI's own user agent, which together are what make
/// an OAuth token issued to Claude Code acceptable here. It can change without
/// notice, and when it does the failure is a parse error or a 4xx, both of
/// which this reports as a state rather than a crash. **TODO(BE):** replace
/// with a supported endpoint if one appears.
class ClaudeUsageSource implements UsageSource {
  ClaudeUsageSource({Dio? dio, UsageCredentials? credentials})
    : _dio = dio ?? attachHttpLog(buildUsageDio()),
      _credentials = credentials ?? const UsageCredentials();

  final Dio _dio;
  final UsageCredentials _credentials;

  static const _url = 'https://api.anthropic.com/api/oauth/usage';

  @override
  UsageProvider get provider => UsageProvider.claude;

  @override
  Future<ProviderUsage> read() async {
    final token = await _credentials.claude();
    if (token == null) return signedOut(provider);
    final accountId = await _credentials.claudeAccountId();
    // An expired token is spent as a sign-in rather than as a round trip: this
    // app does not refresh what the CLI owns, so the request could only fail.
    if (token.isExpired) {
      return ProviderUsage(
        provider: provider,
        status: UsageStatus.signedOut,
        message: 'Claude session expired — run claude to sign in again',
      );
    }
    try {
      final response = await _dio.getUri<Object?>(
        Uri.parse(_url),
        options: Options(
          headers: {
            'Authorization': 'Bearer ${token.accessToken}',
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': 'claude-code/2.1.0',
          },
        ),
      );
      return claudeUsageFromAnswer(
        statusCode: response.statusCode,
        body: response.data,
        account: accountId == null
            ? null
            : usageAccountKey(provider, accountId),
      );
    } on DioException {
      return usageFailureFor(provider, null)!;
    }
  }

  /// The three windows the CLI itself shows, in the order they bite.
  ///
  /// Fable's weekly allowance has been spelled three ways across releases, so
  /// all three are tried — an absent window is simply not drawn, which is why
  /// a build reading a newer server loses a row rather than the whole panel.
  static ProviderUsage _mapWindows(
    Map<Object?, Object?> data, {
    String? account,
  }) {
    final windows = <UsageWindow>[
      ?_window('Session', data['five_hour']),
      ?_window(kWeeklyWindowLabel, data['seven_day']),
      ?_window(
        'Fable',
        data['fable_weekly'] ??
            data['fable_seven_day'] ??
            data['seven_day_fable'],
      ),
    ];
    if (windows.isEmpty) {
      return const ProviderUsage(
        provider: UsageProvider.claude,
        status: UsageStatus.failed,
        message: 'Claude reported no limits',
      );
    }
    return ProviderUsage(
      provider: UsageProvider.claude,
      status: UsageStatus.ok,
      windows: windows,
      fetchedAt: DateTime.now(),
      account: account,
    );
  }

  static UsageWindow? _window(String label, Object? raw) {
    if (raw is! Map) return null;
    final used = parseUsedPercent([raw['utilization'], raw['used_percentage']]);
    if (used == null) return null;
    return UsageWindow(
      label: label,
      usedPercent: used,
      resetsAt: parseResetTimestamp(raw['resets_at']),
    );
  }
}

/// What Claude's usage endpoint said, as the rail draws it.
///
/// Shared by the two places an answer comes from — this computer asking with
/// its own token, and a REMOTE machine asking with its own and handing back
/// exactly what the vendor sent (`usage_read`, see `remote_usage.dart`). One
/// reading of the answer for both, so a window cannot be named one way here and
/// another way for a machine across the relay.
ProviderUsage claudeUsageFromAnswer({
  required int? statusCode,
  required Object? body,
  String? account,
}) {
  final failure = usageFailureFor(UsageProvider.claude, statusCode);
  if (failure != null) return failure;
  if (body is! Map) {
    return const ProviderUsage(
      provider: UsageProvider.claude,
      status: UsageStatus.failed,
      message: 'Claude answered in a shape this build cannot read',
    );
  }
  return ClaudeUsageSource._mapWindows(body, account: account);
}
