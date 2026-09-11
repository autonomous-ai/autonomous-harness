import 'package:dio/dio.dart';

import 'usage_window.dart';

/// One account's usage, fetched from whoever knows it.
///
/// An interface rather than two hard-wired calls, because the two vendors agree
/// on nothing but the question: different hosts, different auth, different
/// field names, different window sets. It is also the seam a per-machine source
/// would arrive through — the CLI could answer this for a remote machine one
/// day without a single widget changing.
abstract class UsageSource {
  UsageProvider get provider;

  /// The current reading, or the state that stands in for one.
  ///
  /// Never throws: every failure is a [ProviderUsage] carrying its own reason,
  /// because the rail has to draw *something* and a thrown exception would make
  /// the caller invent the sentence instead of the source that knows it.
  Future<ProviderUsage> read();
}

/// A Dio configured the way every usage call wants it.
///
/// `validateStatus` lets 4xx through so a 401 can be read as "sign in" rather
/// than surfacing as a transport failure — the split [ApiClient] draws too.
Dio buildUsageDio({String? baseUrl}) => Dio(
  BaseOptions(
    baseUrl: baseUrl ?? '',
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 15),
    validateStatus: (status) => status != null && status >= 200 && status < 600,
  ),
);

/// Turns a finished request into the state the rail should draw.
///
/// Shared because the two vendors fail in the same four ways even though they
/// succeed in different shapes.
ProviderUsage? usageFailureFor(UsageProvider provider, int? statusCode) {
  if (statusCode == null) {
    return ProviderUsage(
      provider: provider,
      status: UsageStatus.failed,
      message: 'Could not reach ${provider.label}',
    );
  }
  if (statusCode == 401 || statusCode == 403) {
    return ProviderUsage(
      provider: provider,
      status: UsageStatus.signedOut,
      message: 'Sign in to ${provider.label} to see usage',
    );
  }
  if (statusCode >= 400) {
    return ProviderUsage(
      provider: provider,
      status: UsageStatus.failed,
      message: '${provider.label} answered $statusCode',
    );
  }
  return null;
}

/// The state a provider is in when its CLI has never signed in here.
ProviderUsage signedOut(UsageProvider provider) => ProviderUsage(
  provider: provider,
  status: UsageStatus.signedOut,
  message: 'Sign in to ${provider.label} to see usage',
);
