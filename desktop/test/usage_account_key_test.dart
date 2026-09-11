// The key a remote machine names its account by has to come out of this app
// byte for byte the same, or the strip prints one subscription twice.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/usage_account_key.dart';
import 'package:harness/usage/usage_window.dart';

void main() {
  test('matches the vector the CLI pins', () {
    // ⚠️ A cross-language contract: `accountUsage.spec.ts` in autonomous-harness
    // asserts these same two strings for its `accountKey`.
    expect(
      usageAccountKey(UsageProvider.claude, 'acct-123'),
      '85d2541574c31caa',
    );
    expect(
      usageAccountKey(UsageProvider.codex, 'acct-123'),
      'd9921dd1861038f4',
    );
  });

  test('the same id on two vendors is two accounts', () {
    expect(
      usageAccountKey(UsageProvider.claude, 'same'),
      isNot(usageAccountKey(UsageProvider.codex, 'same')),
    );
  });
}
