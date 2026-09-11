import 'dart:async';

/// Retries [attempt] with a short doubling backoff, for a transient failure that a moment's wait
/// might clear — not for a real refusal. [isRetryable] decides which errors qualify; the default
/// retries none, so a call site always states its intent explicitly.
Future<T> withRetry<T>(
  Future<T> Function() attempt, {
  int maxAttempts = 3,
  Duration initialDelay = const Duration(milliseconds: 500),
  bool Function(Object error) isRetryable = _never,
}) async {
  var delay = initialDelay;
  for (var tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= maxAttempts || !isRetryable(error)) rethrow;
      await Future.delayed(delay);
      delay *= 2;
    }
  }
}

bool _never(Object _) => false;
