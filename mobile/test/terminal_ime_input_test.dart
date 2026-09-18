import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

import 'keyboard_fakes.dart';

/// The phone has no composer box under its pane — see `phone/terminal_page.dart`
/// — so the terminal's own input connection is the only place a software
/// keyboard has to compose in. Whatever this config says, a Vietnamese Telex or
/// CJK keyboard either gets a pre-edit buffer or types raw letters into the pty.
void main() {
  Terminal newTerminal() =>
      Terminal(maxLines: 200, reflowEnabled: false)..resize(80, 12);

  Future<void> pumpTerminal(
    WidgetTester tester,
    Terminal terminal, {
    bool deleteDetection = false,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 400,
            height: 320,
            child: TerminalView(
              terminal,
              autofocus: true,
              deleteDetection: deleteDetection,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(tester.testTextInput.hasAnyClients, isTrue);
  }

  Future<Map<String, dynamic>> attachedConfig(WidgetTester tester) async {
    await pumpTerminal(tester, newTerminal());
    return tester.testTextInput.setClientArgs!;
  }

  testWidgets(
    'iOS keeps the autocorrection machinery its Telex conversion rides on',
    (tester) async {
      final config = await attachedConfig(tester);

      // `autocorrect: false` reaches UIKit as `UITextAutocorrectionTypeNo`,
      // which is also what stops the Vietnamese keyboard turning `hoo` into
      // `hô`. iOS exposes no separate switch for the two.
      expect(config['autocorrect'], isTrue);
      expect(config['enableSuggestions'], isTrue);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.iOS),
  );

  testWidgets(
    'Android composes with suggestions on and rewrites nothing with '
    'autocorrection off',
    (tester) async {
      final config = await attachedConfig(tester);

      // `enableSuggestions: false` reaches Android as
      // TYPE_TEXT_FLAG_NO_SUGGESTIONS, which takes the composing region — and
      // with it Telex — away entirely.
      expect(config['enableSuggestions'], isTrue);
      expect(config['autocorrect'], isFalse);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  testWidgets(
    'a desktop keyboard composes through marked text and keeps the strict '
    'config',
    (tester) async {
      final config = await attachedConfig(tester);

      expect(config['autocorrect'], isFalse);
      expect(config['enableSuggestions'], isFalse);
    },
    variant: TargetPlatformVariant.desktop(),
  );

  testWidgets(
    'quotes and dashes stay straight on every platform',
    (tester) async {
      final config = await attachedConfig(tester);

      // `"` and `--flag` are syntax at a prompt. Both of these default to
      // enabled, and iOS acts on them the moment autocorrect goes on.
      expect(config['smartDashesType'], SmartDashesType.disabled.index.toString());
      expect(config['smartQuotesType'], SmartQuotesType.disabled.index.toString());
    },
    variant: TargetPlatformVariant.all(),
  );

  testWidgets(
    'Return submits once, and the newline iOS appends after it is not typed '
    'into the pty',
    (tester) async {
      final terminal = newTerminal();
      final outbound = <String>[];
      terminal.onOutput = outbound.add;
      await pumpTerminal(tester, terminal);

      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'hi',
          selection: TextSelection.collapsed(offset: 2),
        ),
      );
      await tester.pump();
      expect(outbound, ['hi']);
      outbound.clear();

      // UIKit answers Return by calling the action FIRST...
      await tester.testTextInput.receiveAction(TextInputAction.newline);
      await tester.pump();

      // ...and then inserting the `\n` into its own buffer anyway, which comes
      // back as an editing value the terminal has already acted on.
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'hi\n',
          selection: TextSelection.collapsed(offset: 3),
        ),
      );
      await tester.pump();

      // Only the Enter. Replaying that value would retype the whole line and
      // then a literal LF, which a TUI reads as Ctrl+J — a soft newline, not a
      // submit — leaving the line sitting in the prompt.
      expect(outbound, ['\r']);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.iOS),
  );

  group('with delete detection, as a phone runs it', () {
    testWidgets('Backspace keeps rubbing out a line the keyboard never typed', (
      tester,
    ) async {
      final terminal = newTerminal();
      final outbound = <String>[];
      terminal.onOutput = outbound.add;
      await pumpTerminal(tester, terminal, deleteDetection: true);

      // A voice transcript sits in the prompt; the native buffer knows
      // nothing of it.
      for (var press = 0; press < 5; press++) {
        await deleteBackward(tester);
      }

      expect(outbound, List.filled(5, '\x7f'));
    }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));

    testWidgets(
      'Return submits once when iOS appends its newline to the padding',
      (tester) async {
        final terminal = newTerminal();
        final outbound = <String>[];
        terminal.onOutput = outbound.add;
        await pumpTerminal(tester, terminal, deleteDetection: true);

        tester.testTextInput.updateEditingValue(
          const TextEditingValue(
            text: '  hi',
            selection: TextSelection.collapsed(offset: 4),
          ),
        );
        await tester.pump();
        outbound.clear();

        await tester.testTextInput.receiveAction(TextInputAction.newline);
        await tester.pump();
        // The race's other winner: the reset landed first, so the newline
        // arrives on the padding rather than on the line.
        tester.testTextInput.updateEditingValue(
          const TextEditingValue(
            text: '  \n',
            selection: TextSelection.collapsed(offset: 3),
          ),
        );
        await tester.pump();

        expect(outbound, ['\r']);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.iOS),
    );
  });

  testWidgets(
    'Telex sends the composed word, not the letters it was typed from',
    (tester) async {
      final terminal = newTerminal();
      final outbound = <String>[];
      terminal.onOutput = outbound.add;
      await pumpTerminal(tester, terminal);

      // `h`, `o`, `o`, `m` as the keyboard rewrites its own pre-edit text.
      for (final pending in const ['h', 'ho', 'hô', 'hôm']) {
        tester.testTextInput.updateEditingValue(
          TextEditingValue(
            text: pending,
            selection: TextSelection.collapsed(offset: pending.length),
            composing: TextRange(start: 0, end: pending.length),
          ),
        );
        await tester.pump();
        expect(outbound, isEmpty, reason: 'pre-edit `$pending` left the pty');
      }

      // Space ends the composition and commits it.
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'hôm ',
          selection: TextSelection.collapsed(offset: 4),
        ),
      );
      await tester.pump();

      expect(outbound, ['hôm ']);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.iOS),
  );

  testWidgets(
    'the keyboard keeps its clipboard, at the price of learning what is typed',
    (tester) async {
      final config = await attachedConfig(tester);

      // `false` here is IME_FLAG_NO_PERSONALIZED_LEARNING, which Gboard reads
      // as incognito — and incognito takes the toolbar, and with it the
      // CLIPBOARD. A phone has no ⌘V and no readable clipboard beyond
      // `text/plain`, so declining the learning also declined every paste.
      expect(config['enableIMEPersonalizedLearning'], isTrue);
    },
    variant: TargetPlatformVariant.all(),
  );

  testWidgets(
    'an undeclared content type is refused before Dart sees it',
    (tester) async {
      final config = await attachedConfig(tester);

      // Empty is Flutter's default, and it is what makes Gboard answer a
      // clipboard image with "the current app does not allow pasting images
      // here" — in the keyboard, with nothing reaching `insertContent` at all.
      expect(config['contentCommitMimeTypes'], isEmpty);
    },
    variant: TargetPlatformVariant.all(),
  );

  testWidgets(
    'a declared type is offered and its bytes reach the host',
    (tester) async {
      KeyboardInsertedContent? received;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 400,
              height: 320,
              child: TerminalView(
                newTerminal(),
                autofocus: true,
                allowedMimeTypes: const ['image/png'],
                onContentInserted: (content) => received = content,
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(
        tester.testTextInput.setClientArgs!['contentCommitMimeTypes'],
        ['image/png'],
      );

      // What the engine sends once the keyboard hands an image over. Delivered
      // on the platform channel rather than through `testTextInput`, which has
      // no helper for content.
      final bytes = <int>[137, 80, 78, 71];
      await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        'flutter/textinput',
        const JSONMethodCodec().encodeMethodCall(
          MethodCall('TextInputClient.performAction', <Object?>[
            -1,
            'TextInputAction.commitContent',
            <String, dynamic>{
              'mimeType': 'image/png',
              'data': bytes,
              'uri': 'content://clip/1',
            },
          ]),
        ),
        (_) {},
      );
      await tester.pump();

      expect(received?.mimeType, 'image/png');
      expect(received?.data, bytes);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  testWidgets(
    "the keyboard's own dictation lands as what was finally heard",
    (tester) async {
      final terminal = newTerminal();
      final outbound = <String>[];
      terminal.onOutput = outbound.add;
      await pumpTerminal(tester, terminal);

      // Voice input on the phone IS the keyboard's mic. Dictation streams its
      // guesses into the buffer and then rewrites them — here the capital, the
      // accents and the question it first misheard — with no composing range
      // to hold any of it back from the pty.
      for (final guess in const [
        'hom nay',
        'hom nay la thu may',
        'Hôm nay là thứ mấy?',
      ]) {
        tester.testTextInput.updateEditingValue(
          TextEditingValue(
            text: guess,
            selection: TextSelection.collapsed(offset: guess.length),
          ),
        );
        await tester.pump();
      }

      // The prompt sees every revision as rubbing out and retyping, so what it
      // ends up holding is the line a readline-style editor would.
      final line = <int>[];
      for (final chunk in outbound) {
        // DEL — the keytab's plain Backspace, one per rune rubbed out.
        if (chunk == '\x7f') {
          line.removeLast();
        } else {
          line.addAll(chunk.runes);
        }
      }
      expect(String.fromCharCodes(line), 'Hôm nay là thứ mấy?');
    },
    variant: TargetPlatformVariant.only(TargetPlatform.iOS),
  );
}
