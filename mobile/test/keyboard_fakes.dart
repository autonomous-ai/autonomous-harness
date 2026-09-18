import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// What UIKit's `deleteBackward` does to the buffer it holds: one character
/// fewer, and NOTHING at all once the buffer is empty. Android's
/// `deleteSurroundingText` reaches Dart the same way, as an edited buffer.
Future<void> deleteBackward(WidgetTester tester) async {
  final text = tester.testTextInput.editingState!['text'] as String;
  if (text.isEmpty) return;
  final left = text.substring(0, text.length - 1);
  tester.testTextInput.updateEditingValue(
    TextEditingValue(
      text: left,
      selection: TextSelection.collapsed(offset: left.length),
    ),
  );
  await tester.pump();
}
