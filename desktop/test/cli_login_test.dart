import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_login.dart';

// The subprocess-spawning parts of CliLogin (checkStatus/login/logout all shell out to a real
// `harness` binary) have no safe local seam to unit-test — same accepted limitation noted elsewhere
// this session for live-transport paths. Only the pure JSON-parsing contract is covered here.
void main() {
  group('CliAuthStatus.fromJson', () {
    test('parses a full logged-in payload', () {
      final status = CliAuthStatus.fromJson({
        'loggedIn': true,
        'computerId': 'a' * 32,
        'machineId': 'm_123',
        'autonomousEnv': 'prod',
        'expiresAt': 1234567890,
      });
      expect(status.loggedIn, isTrue);
      expect(status.computerId, 'a' * 32);
      expect(status.machineId, 'm_123');
      expect(status.autonomousEnv, 'prod');
    });

    test('parses a logged-out payload with no other fields', () {
      final status = CliAuthStatus.fromJson({'loggedIn': false});
      expect(status.loggedIn, isFalse);
      expect(status.computerId, isNull);
      expect(status.machineId, isNull);
      expect(status.autonomousEnv, isNull);
    });

    test('treats a missing/non-true loggedIn field as logged out', () {
      expect(CliAuthStatus.fromJson({}).loggedIn, isFalse);
      expect(CliAuthStatus.fromJson({'loggedIn': 'true'}).loggedIn, isFalse);
    });
  });
}
