import 'dart:convert';

import 'package:cryptography/dart.dart';

import 'usage_window.dart';

/// An account, as both ends of `usage_read` name it: the first 16 hex
/// characters of sha256(`<provider>:<id>`).
///
/// Hashed rather than carried raw because RPC answers are LOGGED — `WsConn`
/// writes every reply to `~/.harness/logs` — and an account id has no business
/// there. Equality survives hashing, and equality is all the strip needs: it is
/// what decides whether a remote machine's subscription is this one again or a
/// different one worth its own figure.
///
/// ⚠️ **A cross-language contract.** A remote machine computes the SAME key in
/// `autonomous-harness/cli/src/lib/accountUsage.ts` (`accountKey`), and the two
/// must agree byte for byte — drift, and every remote reading looks like a
/// different account, so the strip prints one subscription twice. Both suites
/// pin the same vector (`test/usage_account_key_test.dart` here,
/// `accountUsage.spec.ts` there) for exactly that reason.
String usageAccountKey(UsageProvider provider, String accountId) {
  final digest = const DartSha256().hashSync(
    utf8.encode('${provider.name}:$accountId'),
  );
  final hex = StringBuffer();
  for (final byte in digest.bytes) {
    hex.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return hex.toString().substring(0, 16);
}
