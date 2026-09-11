import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('requires explicit CLI capability, never infers it from the installed binary', () {
    expect(
      EngineAvailability.fromJson({'engine': 'codex', 'installed': true})
          ?.supportsCodexHome,
      isFalse,
    );
    expect(
      EngineAvailability.fromJson({
        'engine': 'codex',
        'supportsCodexHome': true,
      })?.supportsCodexHome,
      isTrue,
    );
    expect(
      EngineAvailability.fromJson({
        'engine': 'claude',
        'supportsCodexHome': true,
      })?.supportsCodexHome,
      isFalse,
    );
  });

  test('refuses an explicit profile for a missing capability or a non-Codex engine, never merely for being remote', () async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(notifier.dispose);
    // A remote machine on purpose: discovery/linking now run on the CLI wherever it is, so
    // choosing a profile must not be refused merely because this machine is not "this computer".
    final machine = MachineState(
      const Machine(machineId: 'remote', authMode: MachineAuthMode.remote),
    )..localOnly = false;
    notifier.machineStates['remote'] = machine;
    expect(
      await notifier.createAgent(
        'remote',
        engine: 'codex',
        folder: '/work',
        codexHome: '/accounts/two',
      ),
      contains('Update the harness CLI'),
    );
    machine.engines.replace(const [
      EngineAvailability(
        engine: 'codex',
        installed: true,
        supportsCodexHome: true,
      ),
    ]);
    expect(
      await notifier.createAgent(
        'remote',
        engine: 'claude',
        folder: '/work',
        codexHome: '/accounts/two',
      ),
      contains('only for Codex'),
    );
  });

  test('keeps a full profile path through agent updates and rename', () {
    final path = '/accounts/${'long-name-' * 15}/codex-two';
    final agent = Agent.fromJson({
      'id': 'one',
      'engine': 'codex',
      'codexHome': path,
    });
    expect(agent.codexHome, path);
    expect(agent.copyWith(name: 'renamed').codexHome, path);
    final changed = Agent.fromJson({
      'id': 'one',
      'engine': 'codex',
      'codexHome': '/accounts/other',
    });
    expect(AppNotifier.agentsEqual([agent], [changed]), isFalse);
    expect(
      Agent.fromJson({'id': 'one', 'engine': 'claude', 'codexHome': path})
          .codexHome,
      isNull,
    );
  });
}
