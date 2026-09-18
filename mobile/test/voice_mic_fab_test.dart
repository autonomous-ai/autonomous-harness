import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_mic_fab.dart';
import 'package:harness_mobile/phone/voice_notice.dart';
import 'package:harness_mobile/phone/voice_status_pill.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'voice_fakes.dart';

/// The mic over the terminal: tap to talk, tap to send — the words go as a
/// composer turn. `×` in the pill beside it calls the take off.
void main() {
  late FakeVoiceRecorder recorder;
  late FakeTranscriber backend;
  late ValueNotifier<String> language;
  late VoiceInputController voice;
  late TerminalSession session;
  late List<(String, Map<String, dynamic>)> frames;

  /// What reached the prompt, keystroke by keystroke.
  late List<String> typed;

  final mic = find.byKey(const ValueKey('voice-mic'));

  setUp(() {
    recorder = FakeVoiceRecorder();
    backend = FakeTranscriber();
    language = ValueNotifier('en');
    voice = VoiceInputController(
      transcriber: backend.call,
      recorder: recorder,
      language: language,
    );
    frames = [];
    session = TerminalSession(
      machineId: 'm',
      agentId: 'a',
      agentName: 'Agent',
      engineId: 'claude',
      send: (type, payload) async {
        frames.add((type, payload));
        return true;
      },
      sendBinary: (_) async => true,
    );
    session.status = TerminalSessionStatus.controlling;
    session.streamId = 's';
    typed = [];
    session.terminal.onOutput = typed.add;
  });

  tearDown(() {
    voice.dispose();
    language.dispose();
    session.dispose();
  });

  Widget fab() => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Flexible(child: VoiceStatusPill(voice: voice)),
      VoiceMicFab(voice: voice, session: session),
    ],
  );

  final cancel = find.byKey(const ValueKey('voice-cancel'));

  Future<void> pumpFab(WidgetTester tester, {Widget? around}) =>
      tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: around ?? Center(child: fab())),
        ),
      );

  List<Object?> sentTurns() => [
    for (final (type, payload) in frames)
      if (type == 'message') payload['content'],
  ];

  // Never typed into the pane with a Return behind them: arriving together, a
  // TUI reads the pair as a paste and the Return becomes a newline — Codex left
  // the words in its prompt, unsent. See `_tapAction`.
  testWidgets('tap, talk, tap Send: the words go as a composer turn', (
    tester,
  ) async {
    await pumpFab(tester);
    backend.replies.add('ship it');

    await tester.tap(mic);
    await tester.pump();
    expect(voice.status, VoiceInputStatus.listening);

    await tester.tap(mic);
    await tester.pumpAndSettle();

    expect(sentTurns(), ['ship it']);
    expect(typed, isEmpty);
    expect(voice.isIdle, isTrue);
  });

  testWidgets('a send that cannot land keeps the words for the next tap', (
    tester,
  ) async {
    await pumpFab(tester);
    backend.replies.add('ship it');

    await tester.tap(mic);
    await tester.pump();
    session.status = TerminalSessionStatus.takenOver;
    session.notifyListeners();
    await tester.pump();
    await tester.tap(mic);
    await tester.pumpAndSettle();

    expect(sentTurns(), isEmpty);
    expect(voice.transcript, 'ship it');
    expect(voice.notice, VoiceNotice.notSent);

    session.status = TerminalSessionStatus.controlling;
    session.notifyListeners();
    await tester.pump();
    await tester.tap(mic);
    await tester.pumpAndSettle();

    expect(sentTurns(), ['ship it']);
    expect(voice.isIdle, isTrue);
  });

  testWidgets('× while talking throws the take away', (tester) async {
    await pumpFab(tester);
    backend.replies.add('never mind');

    await tester.tap(mic);
    await tester.pump();
    await tester.tap(cancel);
    await tester.pumpAndSettle();

    expect(recorder.cancels, 1);
    expect(backend.calls, isEmpty);
    expect(typed, isEmpty);
    expect(voice.isIdle, isTrue);
  });

  testWidgets('no talking while the terminal takes no input', (tester) async {
    session.status = TerminalSessionStatus.takenOver;
    await pumpFab(tester);

    await tester.tap(mic);
    await tester.pumpAndSettle();

    expect(recorder.starts, 0);
    expect(frames, isEmpty);
  });
}
