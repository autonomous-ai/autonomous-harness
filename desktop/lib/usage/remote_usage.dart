import 'claude_usage_source.dart';
import 'codex_usage_source.dart';
import 'usage_source.dart';
import 'usage_window.dart';

/// One remote machine's `usage_read_result`, as readings the rail can draw.
///
/// The machine answered with its vendors' replies exactly as they came — HTTP
/// status and body (`autonomous-harness/cli/src/lib/accountUsage.ts`) — so they
/// are read here by the SAME mappers that read this computer's own
/// ([claudeUsageFromAnswer], [codexUsageFromAnswer]). A window cannot be named
/// one way for this Mac and another way for a machine across the relay, because
/// there is only one place that names it.
///
/// Never throws: an entry this build cannot read is dropped rather than failing
/// the machine's whole answer, and an answer with no readable entry is empty —
/// which the caller treats as a machine with nothing to add.
List<ProviderUsage> parseUsageReadResult(Map<String, dynamic> reply) {
  final providers = reply['providers'];
  if (providers is! List) return const [];
  return [
    for (final entry in providers)
      if (entry is Map) ?_readingFrom(entry),
  ];
}

ProviderUsage? _readingFrom(Map<Object?, Object?> entry) {
  final provider = switch (entry['provider']) {
    'claude' => UsageProvider.claude,
    'codex' => UsageProvider.codex,
    // A provider a newer CLI reports and this build has never heard of.
    _ => null,
  };
  if (provider == null) return null;
  final account = entry['account'];
  final accountKey = account is String && account.isNotEmpty ? account : null;
  switch (entry['outcome']) {
    case 'answered':
      final status = entry['httpStatus'];
      final statusCode = status is int ? status : null;
      final body = entry['body'];
      return switch (provider) {
        UsageProvider.claude => claudeUsageFromAnswer(
          statusCode: statusCode,
          body: body,
          account: accountKey,
        ),
        UsageProvider.codex => codexUsageFromAnswer(
          statusCode: statusCode,
          body: body,
          account: accountKey,
        ),
      };
    case 'signedOut':
      // The machine's own sentence when it has one — it is the side that knows
      // whether the session expired or was never there.
      final message = entry['message'];
      return message is String && message.isNotEmpty
          ? ProviderUsage(
              provider: provider,
              status: UsageStatus.signedOut,
              message: message,
            )
          : signedOut(provider);
    default:
      // `unreachable`, or an outcome a newer CLI invented: the vendor was not
      // heard from, which reads exactly like this computer failing to reach it.
      return usageFailureFor(provider, null);
  }
}
