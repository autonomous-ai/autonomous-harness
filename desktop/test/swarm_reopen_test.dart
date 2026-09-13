import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/terminal/terminal_session.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp, MemoryStore;

class _NoopLogin extends CliLogin {
  int logoutCalls = 0;
  @override
  Future<void> logout() async {
    logoutCalls++;
  }
}

void main() {
  test('recently closed swarms do not survive sign-out', () async {
    final login = _NoopLogin();
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      cliLogin: login,
    );
    addTearDown(app.dispose);
    app.renameSwarm(app.activeSwarmId, 'Private work');
    await app.closeSwarm(app.activeSwarmId);
    expect(app.canReopenClosedSwarm, isTrue);
    await app.logout();
    expect(login.logoutCalls, 1);
    expect(app.canReopenClosedSwarm, isFalse);
    app.reopenClosedSwarm();
    expect(app.swarms.every((s) => s.name != 'Private work'), isTrue);
  });

  test('only the latest 24 closed arrangements are retained', () async {
    final app = createApp();
    addTearDown(app.dispose);
    for (var i = 0; i < 27; i++) {
      app.renameSwarm(app.activeSwarmId, 'Closed $i');
      await app.closeSwarm(app.activeSwarmId);
    }
    for (var i = 26; i >= 3; i--) {
      app.reopenClosedSwarm();
      expect(app.activeSwarm.name, 'Closed $i');
    }
    expect(app.swarms, hasLength(24));
    // Make room without recording another close, to distinguish an empty
    // history from the independent open-tab limit.
    app.swarms.removeLast();
    app.selectSwarm(app.swarms.first.id);
    expect(app.canReopenClosedSwarm, isFalse);
  });
  test(
    'reopen restores an arrangement and preserves changes to shared views',
    () async {
      final store = MemoryStore();
      final app = createApp(store: store);
      addTearDown(app.dispose);
      app.renameSwarm(app.activeSwarmId, 'Work');
      await app.addAgentToSwarm('m', 'a0');
      await app.addAgentToSwarm('m', 'a1');
      final original = app.activeSwarm;
      final shared = original.panes.first;
      app.focusPane(shared.id);
      app.togglePinPane(shared.id);
      app.setPreset(2, PanePreset.rows);
      app.toggleZoomPane();
      final wallpaper = original.wallpaper;
      app.newSwarm(name: 'Keep working');
      final other = app.activeSwarm;
      await app.addAgentToSwarm('m', 'a0');
      await app.closeSwarm(original.id);
      app.toggleComposer(shared.id);
      await app.addAgentToSwarm('m', 'a2');
      app.reopenClosedSwarm();
      expect(app.swarms.map((s) => s.name), ['Work', 'Keep working']);
      expect(app.activeSwarmId, original.id);
      expect(app.panes.map((p) => p.agentId), ['a0', 'a1']);
      expect(app.panes.first, same(shared));
      expect(shared.composerVisible, isTrue);
      expect(app.activeSwarm.wallpaper, wallpaper);
      expect(app.presetFor(2), PanePreset.rows);
      expect(app.focusedPaneId, shared.id);
      expect(app.zoomedPaneId, shared.id);
      expect(app.activeSwarm.previousPaneId, app.panes.last.id);
      expect(app.isPanePinned(shared), isTrue);
      expect(other.panes.map((p) => p.agentId), ['a0', 'a2']);
      expect(other.pinnedSlots, isEmpty);
      await app.flushPaneLayout();
      final restored = createApp(store: store);
      addTearDown(restored.dispose);
      await restored.restorePaneLayoutForTest();
      expect(restored.swarms.map((s) => s.name), ['Work', 'Keep working']);
      expect(restored.activeSwarmId, original.id);
      expect(restored.canReopenClosedSwarm, isFalse);
    },
  );

  test('reopen replaces only an untouched automatic welcome', () async {
    final app = createApp();
    addTearDown(app.dispose);
    await app.addAgentToSwarm('m', 'a0');
    final original = app.activeSwarmId;
    await app.closeSwarm(original);
    for (var i = 0; i < 30; i++) {
      await app.closeSwarm(app.activeSwarmId);
    }
    app.reopenClosedSwarm();
    expect(app.swarms.single.id, original);
    expect(app.panes.single.agentId, 'a0');
    await app.closeSwarm(original);
    app.renameSwarm(app.activeSwarmId, 'New plans');
    final plans = app.activeSwarm;
    app.reopenClosedSwarm();
    expect(app.swarms, hasLength(2));
    expect(app.swarms, contains(same(plans)));
    expect(plans.name, 'New plans');
  });

  test('reopen does not wait for a closing terminal and cannot resurrect its controller', () async {
    final closeReply = Completer<bool>();
    final app = createApp();
    addTearDown(app.dispose);
    final session =
        TerminalSession(
            machineId: 'm',
            agentId: 'a0',
            agentName: 'Work',
            engineId: 'codex',
            send: (type, _) => type == 'terminal_close'
                ? closeReply.future
                : Future.value(true),
            sendBinary: (_) async => true,
          )
          ..streamId = 'closing-stream'
          ..status = TerminalSessionStatus.controlling;
    final oldPane = app.adoptSessionForTest(session);
    final closing = app.closeSwarm(app.activeSwarmId);
    app.reopenClosedSwarm();
    final reopened = app.panes.single;
    expect(reopened, isNot(same(oldPane)));
    expect(reopened.session, isNull);
    closeReply.complete(true);
    await closing;
    expect(app.panes.single, same(reopened));
  });

  test(
    'history is bounded, newest-first and retained while capacity is full',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      for (var i = 0; i < AppNotifier.maxClosedSwarms + 3; i++) {
        app.renameSwarm(app.activeSwarmId, 'Closed $i');
        await app.closeSwarm(app.activeSwarmId);
      }
      for (var i = 0; i < AppNotifier.maxSwarms - 1; i++) {
        app.newSwarm();
      }
      expect(app.canReopenClosedSwarm, isFalse);
      app.reopenClosedSwarm();
      expect(app.swarms, hasLength(AppNotifier.maxSwarms));
      await app.closeSwarm(app.activeSwarmId);
      app.reopenClosedSwarm();
      expect(app.activeSwarm.name, 'New swarm');
      // Free slots directly without adding newer close records to this check.
      app.swarms.removeRange(1, app.swarms.length);
      app.selectSwarm(app.swarms.single.id);
      app.reopenClosedSwarm();
      expect(app.activeSwarm.name, 'Closed 26');
    },
  );

  testWidgets('Cmd-Shift-T restores the last closed swarm from the welcome', (
    tester,
  ) async {
    final app = createApp();
    await app.addAgentToSwarm('m', 'a0');
    app.renameSwarm(app.activeSwarmId, 'My work');
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyW);
    expect(app.panes, isEmpty);
    await chord(tester, LogicalKeyboardKey.keyT, shift: true);
    expect(app.activeSwarm.name, 'My work');
    expect(app.panes.single.agentId, 'a0');
    expect(app.canReopenClosedSwarm, isFalse);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
