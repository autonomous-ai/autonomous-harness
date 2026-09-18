// What a pane says when its machine is not in the list.
//
// "Waiting for this machine to answer…" is only honest while there is something to wait FOR. When the
// machine LIST itself could not be read, the machine is not slow — it is unknown, and a spinner that
// never ends tells the user nothing and offers them nothing. This is the difference between those two.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/ws/local_cli_discovery.dart';

class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());
  final lists = <Completer<List<Machine>>>[];

  @override
  Future<Map<String, dynamic>?> me() async => null;

  @override
  Future<List<Machine>> machines() {
    final result = Completer<List<Machine>>();
    lists.add(result);
    return result.future;
  }
}

class _Cli extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: true);
  @override
  Future<void> login({void Function(String url)? onAuthorizeUrl}) async {}
  @override
  Future<void> logout() async {}
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => null;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

class _App extends AppNotifier {
  _App(_Api api)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        cliLogin: _Cli(),
        localCliDiscovery: _Discovery(),
        configStore: null,
      ) {
    this.api = api;
  }
  @override
  Future<void> ensureCliDaemonReady() async {}
}

const _waiting = 'Waiting for this machine to answer…';

/// Run the refresh chain until it has actually asked for the list.
///
/// It must be `pump`, not `await`ing a signal from the stub: inside `testWidgets` the clock is fake, and
/// awaiting a bare future parks the test on a chain that only `pump` can advance — the whole test then
/// hangs until its timeout. Pumping frames is what drives it.
Future<void> _untilRequested(WidgetTester tester, _Api api, int count) async {
  for (var i = 0; i < 20 && api.lists.length < count; i++) {
    await tester.pump(Duration.zero);
  }
  expect(
    api.lists.length,
    greaterThanOrEqualTo(count),
    reason: 'the machine list was never requested',
  );
}

Future<void> _pump(WidgetTester tester, AppNotifier app) async {
  await tester.pumpWidget(
    MaterialApp(home: PaneGrid(notifier: app, swarmMode: false)),
  );
  await tester.pump();
}

void main() {
  late _Api api;
  late _App app;
  late bool disposed;

  setUp(() {
    api = _Api();
    app = _App(api);
    disposed = false;
    app.status = AppStatus.authenticated;
    // A pane restored from the saved layout: it knows its machineId, and nothing else does yet.
    app.panes.add(TerminalPane(id: 0, machineId: 'm', agentId: 'a0'));
  });

  tearDown(() {
    if (!disposed) app.dispose();
  });

  // A failed load leaves the automatic recovery timer armed (by design — it is what gets the list back).
  // The widget-test binding checks for pending timers when the BODY ends, before tearDown runs, so a test
  // that deliberately ends in the failed state has to close the notifier itself.
  void end() {
    app.dispose();
    disposed = true;
  }

  testWidgets('keeps waiting while the list has simply not arrived', (
    tester,
  ) async {
    await _pump(tester, app);
    expect(find.text(_waiting), findsOneWidget);
    expect(find.text('RETRY'), findsNothing);
    end();
  });

  testWidgets('says the machine is unknown, and offers a retry, once the list fails', (
    tester,
  ) async {
    final retry = app.retryMachines();
    await _untilRequested(tester, api, 1);
    api.lists.single.completeError(
      ApiException('Could not reach the Harness backend', status: 502),
    );
    await retry;
    await _pump(tester, app);

    expect(find.text(_waiting), findsNothing);
    expect(find.textContaining('this machine is unknown'), findsOneWidget);
    expect(find.byIcon(Icons.cloud_off), findsOneWidget);

    // And the button reaches the same reload the error strip's RETRY does.
    expect(api.lists, hasLength(1));
    await tester.tap(find.text('RETRY'));
    await _untilRequested(tester, api, 2);
    end();
  });

  testWidgets('goes back to waiting once the list loads again', (tester) async {
    final failed = app.retryMachines();
    await _untilRequested(tester, api, 1);
    api.lists.single.completeError(ApiException('boom', status: 502));
    await failed;
    await _pump(tester, app);
    expect(find.byIcon(Icons.cloud_off), findsOneWidget);

    final ok = app.retryMachines();
    await _untilRequested(tester, api, 2);
    api.lists.last.complete(const []);
    await ok;
    await _pump(tester, app);

    // The list is readable again; this machine is merely absent from it.
    expect(find.text(_waiting), findsOneWidget);
    expect(find.text('RETRY'), findsNothing);
    end();
  });
}
