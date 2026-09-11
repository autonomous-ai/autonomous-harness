import 'package:harness/core/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Machine.fromJson parses control-plane fields', () {
    final m = Machine.fromJson({
      'machineId': 'abc123',
      'apiKey': 'sk-xxx',
      'authMode': 'remote',
      'engine': 'claude',
      'name': 'MacBook Pro',
    });
    expect(m.machineId, 'abc123');
    expect(m.authMode, MachineAuthMode.remote);
    expect(m.engine, 'claude');
    expect(m.displayName, 'MacBook Pro');
  });

  test('Machine display name falls back to machine-<id8>', () {
    final m = Machine.fromJson({
      'machineId': 'abcdef123456',
      'apiKey': 'k',
      'authMode': 'managed',
    });
    expect(m.displayName, 'machine-abcdef12');
  });

  test('CurrentUserProfile parses /api/auth/me and derives initials', () {
    final profile = CurrentUserProfile.fromMe({
      'user': {
        'id': 'user-1',
        'name': 'Diego Nguyen',
        'email': 'diego@autonomous.ai',
      },
      'avatarUrl': null,
    });

    expect(profile.id, 'user-1');
    expect(profile.displayName, 'Diego Nguyen');
    expect(profile.email, 'diego@autonomous.ai');
    expect(profile.initials, 'DN');
  });

  test('CurrentUserProfile rejects a response without an email', () {
    expect(
      () => CurrentUserProfile.fromMe({
        'user': {'id': 'user-1'},
      }),
      throwsFormatException,
    );
  });
}
