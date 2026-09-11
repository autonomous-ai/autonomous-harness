// Settings ▸ Terminal, after it was rebuilt on the app's own `SettingRow`.
//
// Like `settings_screen_test.dart`, this NEVER calls a mutating method on
// `terminalFontStore`: that singleton persists through the real
// `HarnessFileStore`, i.e. the user's actual `~/.harness/desktop-app/state.json`.
// Everything here reads the store's untouched default, so the size stepper is
// exercised at 13pt (both buttons live) rather than driven to a bound.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/settings/sections/terminal_section.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/terminal/terminal_font_store.dart';

/// The sample line inside the preview — the row of `m`s the renderer measures
/// its cell with.
final _sample = find.byWidgetPredicate(
  (w) => w is Text && (w.textSpan?.toPlainText().startsWith('┌─') ?? false),
);

Widget _host({double textScale = 1.0}) => MaterialApp(
  theme: buildAppTheme(brightness: Brightness.light),
  home: Builder(
    builder: (context) {
      AppTheme.brightness.value = Brightness.light;
      return BrightnessScope(
        child: MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(textScale)),
          // The pane the settings rail leaves for a section at the window's
          // own minimum width.
          child: const Scaffold(
            body: SizedBox(width: 820, height: 700, child: TerminalSection()),
          ),
        ),
      );
    },
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the pane lays out with no overflow at the window minimum', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(820 * 2, 700 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('Font'), findsOneWidget);
    expect(find.text('Size'), findsOneWidget);
    expect(find.text('Preview'), findsOneWidget);
    expect(_sample, findsOneWidget);
  });

  testWidgets('the preview refuses the app-wide text scale', (tester) async {
    // The fifth seam named in `appearance_section.dart`, and the one nothing
    // guarded: the preview exists to show the size the TERMINAL will render
    // at, so a sample that grew with the app's UI scale would advertise a size
    // the terminal never draws.
    tester.view.physicalSize = const Size(820 * 2, 700 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();
    final resting = tester.getSize(_sample);

    await tester.pumpWidget(_host(textScale: 2.0));
    await tester.pumpAndSettle();
    final scaled = tester.getSize(_sample);

    expect(
      scaled,
      resting,
      reason:
          'the preview is drawn at the terminal font size, not the app text '
          'scale — see TextScaler.noScaling in _Screen',
    );
  });

  testWidgets('Reset is dead while the pick already IS the default', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(820 * 2, 700 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();

    expect(terminalFontStore.isDefault, isTrue);
    final reset = tester.widget<OutlinedButton>(
      find.byKey(const Key('terminal-settings-reset-button')),
    );
    expect(
      reset.onPressed,
      isNull,
      reason: 'a Reset that would change nothing should not look pressable',
    );
  });
}
