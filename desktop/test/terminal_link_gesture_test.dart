import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

void main() {
  testWidgets('primary click reaches the terminal tap callback', (
    tester,
  ) async {
    final terminal = Terminal()..write('/tmp/preview.png');
    final tapped = <CellOffset>[];
    final key = GlobalKey<TerminalViewState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalView(
            terminal,
            key: key,
            padding: const EdgeInsets.all(10),
            onTapUp: (_, cell) => tapped.add(cell),
          ),
        ),
      ),
    );
    final render = key.currentState!.renderTerminal;
    final point = render.localToGlobal(
      render.getOffset(const CellOffset(5, 0)) +
          Offset(render.cellSize.width / 2, render.cellSize.height / 2),
    );
    await tester.tapAt(point, kind: PointerDeviceKind.mouse);
    await tester.pump(const Duration(milliseconds: 350));
    expect(tapped, [const CellOffset(5, 0)]);
  });
}
