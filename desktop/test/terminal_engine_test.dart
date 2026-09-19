// A terminal is an engine the daemon calls `terminal`: a shell in a tile that
// becomes whatever gets typed into it and a shell again when that exits. What
// the app must get right about one is pinned here — its face, its chord, and
// that a tile already attached follows the engine change without reopening.
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shortcuts/app_shortcuts.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/engine_identity.dart';

void main() {
  group('the terminal engine has a face but is not an engine to pick', () {
    test('engineIdentity knows it, allEngines does not', () {
      final identity = engineIdentity(kTerminalEngine);
      expect(identity.id, 'terminal');
      expect(identity.label, 'Terminal');
      expect(isTerminalEngine('terminal'), isTrue);
      expect(isTerminalEngine('claude'), isFalse);
      expect(isTerminalEngine(null), isFalse);
      // New Harness and `engines_probe` never see it.
      expect(allEngines.map((e) => e.id), isNot(contains('terminal')));
    });
  });

  group('⌘⇧T', () {
    test('is New Terminal in the live table, and reopen keeps no chord', () {
      final shiftT = kSwarmShortcuts.where(
        (s) =>
            s.activator.trigger == LogicalKeyboardKey.keyT &&
            s.activator.meta &&
            s.activator.shift,
      );
      expect(shiftT.single.action, ShortcutAction.newTerminal);
      expect(
        appShortcuts().where(
          (s) => s.action == ShortcutAction.reopenClosedSwarm,
        ),
        isEmpty,
      );
      expect(harnessCommandById['terminal.new']!.keys, ['cmd+shift+t']);
      expect(harnessCommandById['terminal.new']!.nativeAction, 'newTerminal');
      expect(harnessCommandById['swarm.reopen']!.keys, isEmpty);
      // Still a command: the palette and the History menu list it.
      expect(
        harnessCommandById['swarm.reopen']!.action,
        ShortcutAction.reopenClosedSwarm,
      );
    });
  });

  group('a tile follows its agent\'s engine', () {
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Mac mini',
    );

    Map<String, dynamic> synced(String engine) => {
      'type': 'agent_synced',
      'payload': {
        'agent': {
          'id': 'term-1',
          'name': 'Terminal 1',
          'engine': engine,
          'status': 'active',
          'launch': {'state': 'ready'},
          'terminal': {
            'available': true,
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%9'},
            ],
          },
        },
      },
    };

    test(
      'agent_synced with a new engine re-labels the open session in place',
      () async {
        final notifier = AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(),
          configStore: null,
        );
        addTearDown(notifier.dispose);
        notifier.machineStates['m'] = MachineState(machine);
        await notifier.handleEventForTest('m', synced('terminal'));
        final session = TerminalSession(
          machineId: 'm',
          agentId: 'term-1',
          agentName: 'Terminal 1',
          engineId: 'terminal',
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        );
        final pane = notifier.adoptSessionForTest(session);
        var notified = 0;
        session.addListener(() => notified++);

        // Somebody typed `claude` into it.
        await notifier.handleEventForTest('m', synced('claude'));
        expect(session.engineId, 'claude');
        expect(notified, 1);
        expect(notifier.panes.single, same(pane));
        expect(notifier.machineStates['m']!.agents.single.engine, 'claude');

        // And it exited.
        await notifier.handleEventForTest('m', synced('terminal'));
        expect(session.engineId, 'terminal');
        expect(notified, 2);
        // The same engine again says nothing.
        await notifier.handleEventForTest('m', synced('terminal'));
        expect(notified, 2);
        // Never removed by either flip.
        expect(notifier.panes, hasLength(1));
      },
    );
  });
}
