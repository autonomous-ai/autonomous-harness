import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_composer.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

/// The app's UI type settings must not reach the terminal.
///
/// The user drew that line themselves — the terminal carries its OWN font
/// settings (Settings ▸ Terminal) because its type is a grid a remote program
/// draws into, not a label the app writes. The cost of getting it wrong is not
/// cosmetic: a changed cell size or a changed pane height re-derives `rows`,
/// and `Terminal.resize` fires `onResize` unconditionally, which puts a
/// `terminal_resize` frame on the wire and a SIGWINCH at the far end.
///
/// There are TWO independent channels that could carry the setting across, and
/// they need different fences, so both are measured here:
///
///   1. `MediaQuery`'s text scaler — reaches the xterm grid through
///      `TerminalView`'s `textScaler ?? MediaQuery.textScalerOf(context)`.
///   2. `AppFont.uiScale` — a plain static the THEME reads
///      (`AppControl.heightFieldScaled`, and a padding multiplied by it), so no
///      scaling scope can hold it back. It reaches the terminal by growing the
///      composer's box and shrinking the pane above it.
///
/// Geometry is MEASURED with `getRect`/`getSize` rather than argued from the
/// source, per §14.1 of the design-system doc.

AppNotifier _notifier() {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  final machine = Machine(
    machineId: 'm1',
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: 'm1',
    status: 'online',
  );
  app.machines = [machine];
  // `localOnly: false` — the composer only exists for a REMOTE pane, which is
  // exactly the case this isolation protects.
  app.machineStates['m1'] = MachineState(machine)..localOnly = false;
  return app;
}

Future<TerminalSession> _liveSession() async {
  const streamId = '00112233-4455-6677-8899-aabbccddeeff';
  Object? openRequestId;
  final session = TerminalSession(
    machineId: 'm1',
    agentId: 'a1',
    agentName: 'a1',
    engineId: 'claude',
    send: (type, payload) async {
      if (type == 'terminal_open') openRequestId = payload['requestId'];
      return true;
    },
    sendBinary: (_) async => true,
  );
  await session.open(initialCols: 80, initialRows: 24);
  await session.handleFrame('terminal_ready', {
    'requestId': openRequestId,
    'protocolVersion': 3,
    'streamId': streamId,
    'agentId': 'a1',
  });
  await session.handleBinary(
    TerminalBinaryFrame(
      kind: TerminalBinaryKind.keyframe,
      streamId: streamId,
      seq: 0,
      bytes: Uint8List.fromList(utf8.encode(r'$ ')),
      compressed: false,
      cols: 80,
      rows: 24,
    ),
  );
  return session;
}

/// The pane, under a given app-wide UI text scale — the same mechanism
/// `MaterialApp.builder` uses in `main.dart`.
Widget _host(AppNotifier app, TerminalSession session, {double uiScale = 1}) =>
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      builder: (context, child) => MediaQuery.withClampedTextScaling(
        minScaleFactor: uiScale,
        maxScaleFactor: uiScale,
        child: child ?? const SizedBox.shrink(),
      ),
      // ⚠️ Zero, and the test is worthless without it. `MaterialApp` wraps its
      // theme in an `AnimatedTheme` that lerps over 200ms, so a single `pump()`
      // still reports the OLD ThemeData — which made an earlier version of this
      // test pass with the guard REMOVED. Measure after the theme has actually
      // arrived, and settle rather than pumping one frame.
      themeAnimationDuration: Duration.zero,
      home: Scaffold(
        body: SizedBox(
          width: 900,
          height: 400,
          child: TerminalPanel(
            notifier: app,
            session: session,
            focused: true,
            composerVisible: true,
            onToggleComposer: () {},
          ),
        ),
      ),
    );

/// The top of the UI-size range the Appearance screen offers (19 / 14). The
/// isolation is measured at the extreme, because that is where a leak is
/// largest and where a row is actually lost.
const double _maxScale = 19 / 14;

void main() {
  // `AppFont`'s settings are process-wide statics, so a test that moves them
  // would otherwise leak into every test that runs after it.
  tearDown(grid.AppFont.reset);

  testWidgets('the terminal grid refuses the app-wide text scale', (
    tester,
  ) async {
    final app = _notifier();
    final session = await _liveSession();
    await tester.pumpWidget(_host(app, session, uiScale: _maxScale));
    await tester.pumpAndSettle();

    final view = tester.widget<TerminalView>(find.byType(TerminalView));
    // Explicit, not inherited: without this the view falls back to the ambient
    // scaler and the UI setting would land on the cell size.
    expect(
      view.textScaler,
      TextScaler.noScaling,
      reason:
          'TerminalView must pin its own scaler, not inherit the app UI one',
    );
    session.dispose();
    app.dispose();
  });

  testWidgets('the terminal is drawn ONLY from its own settings', (
    tester,
  ) async {
    // A standing fence, not a scaling one. The pane a remote agent draws into is
    // reviewed with the terminal, never with the app's design system — so every
    // input that decides what the grid looks like has to come from
    // `terminalFontStore` and nothing else. If a future design pass reaches in
    // here, this is what says no.
    final app = _notifier();
    final session = await _liveSession();
    await tester.pumpWidget(_host(app, session, uiScale: _maxScale));
    await tester.pumpAndSettle();

    final view = tester.widget<TerminalView>(find.byType(TerminalView));
    expect(
      view.textStyle,
      same(terminalFontStore.value),
      reason: "the face and size are the terminal store's, not the theme's",
    );
    expect(view.padding, const EdgeInsets.all(10));
    expect(view.textScaler, TextScaler.noScaling);

    session.dispose();
    app.dispose();
  });

  testWidgets(
    'the composer renders its type at the terminal size, not the UI one',
    (tester) async {
      final app = _notifier();
      final session = await _liveSession();
      await tester.pumpWidget(_host(app, session, uiScale: _maxScale));
      await tester.pump();

      // The RENDERED size, not the requested one: `style.fontSize` would pass
      // even with the scaler applied on top of it, which is the bug.
      final field = find.descendant(
        of: find.byType(TerminalComposer),
        matching: find.byType(EditableText),
      );
      final editable = tester.widget<EditableText>(field);
      expect(
        editable.textScaler ?? MediaQuery.textScalerOf(tester.element(field)),
        TextScaler.noScaling,
        reason:
            'what is typed here lands in the terminal, so it wears the '
            'terminal face at the terminal size',
      );
      session.dispose();
      app.dispose();
    },
  );

  testWidgets(
    'AppFont.uiScale cannot change the pane height the terminal gets',
    (tester) async {
      // This is the channel a scaling scope does NOT cover: the theme reads
      // `AppFont.uiScale` directly, so the composer's BOX would grow with it
      // and steal rows from the terminal.
      final app = _notifier();
      final session = await _liveSession();

      await tester.pumpWidget(_host(app, session));
      await tester.pumpAndSettle();
      final restingComposer = tester.getSize(find.byType(TerminalComposer));
      final restingTerminal = tester.getSize(find.byType(TerminalView));

      grid.AppTheme.fonts.apply(uiScale: _maxScale, codeSize: 12.5);
      await tester.pumpWidget(_host(app, session, uiScale: _maxScale));
      await tester.pumpAndSettle();
      final scaledComposer = tester.getSize(find.byType(TerminalComposer));
      final scaledTerminal = tester.getSize(find.byType(TerminalView));

      // Proof the setting really moved, so a no-op apply cannot make the two
      // assertions below pass for the wrong reason.
      expect(grid.AppControl.heightFieldScaled, greaterThan(40));

      expect(
        scaledComposer.height,
        restingComposer.height,
        reason:
            'the composer box is pinned; if it grows it steals terminal rows '
            'and pushes a terminal_resize to the remote agent',
      );
      expect(scaledTerminal.height, restingTerminal.height);
      session.dispose();
      app.dispose();
    },
  );
}
