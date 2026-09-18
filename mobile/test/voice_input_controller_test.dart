import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/phone/voice_notice.dart';

import 'voice_fakes.dart';

void main() {
  late FakeVoiceRecorder recorder;
  late FakeTranscriber backend;
  late ValueNotifier<String> language;
  late VoiceInputController voice;

  setUp(() {
    recorder = FakeVoiceRecorder();
    backend = FakeTranscriber();
    language = ValueNotifier('en');
    voice = VoiceInputController(
      transcriber: backend.call,
      recorder: recorder,
      language: language,
    );
  });

  tearDown(() {
    voice.dispose();
    language.dispose();
  });

  test('at rest until the mic is pressed', () async {
    expect(voice.isIdle, isTrue);
    expect(recorder.starts, 0);

    await voice.startListening();

    expect(voice.status, VoiceInputStatus.listening);
    expect(recorder.recording, isTrue);
    expect(voice.isIdle, isFalse);
  });

  test('an empty take leaves the mic at rest again', () async {
    await voice.startListening();

    await voice.stopListening();

    expect(voice.isIdle, isTrue, reason: 'the take came back empty');
  });

  test('stopping sends the take to the backend and keeps its words', () async {
    backend.replies.add('fix the failing test');
    await voice.startListening();

    await voice.stopListening();

    expect(backend.calls.single.lang, 'en');
    expect(voice.transcript, 'fix the failing test');
    expect(voice.status, VoiceInputStatus.idle);
  });

  test(
    'the words wait for the backend: nothing shows mid-transcription',
    () async {
      backend.pending = Completer<String>();
      await voice.startListening();

      final stopping = voice.stopListening();
      await Future<void>.delayed(Duration.zero);
      expect(voice.status, VoiceInputStatus.transcribing);
      expect(voice.transcript, isEmpty);

      backend.pending!.complete('run the tests');
      await stopping;
      expect(voice.transcript, 'run the tests');
    },
  );

  test('a second take adds to what the first one heard', () async {
    backend.replies.addAll(['run the tests', 'then commit']);
    await voice.startListening();
    await voice.stopListening();

    await voice.startListening();
    await voice.stopListening();

    expect(voice.transcript, 'run the tests then commit');
  });

  test('a refused microphone says so, and the next press asks again', () async {
    recorder.permitted = false;
    await voice.startListening();

    expect(voice.status, VoiceInputStatus.unavailable);
    expect(voice.notice, VoiceNotice.unavailable);

    recorder.permitted = true;
    await voice.startListening();
    expect(voice.status, VoiceInputStatus.listening);
  });

  test('clearing while the permission prompt is up records nothing', () async {
    recorder.pendingPermission = Completer<bool>();
    final opening = voice.startListening();
    expect(voice.status, VoiceInputStatus.starting);

    voice.clear();
    recorder.pendingPermission!.complete(true);
    await opening;

    expect(recorder.starts, 0);
    expect(voice.status, VoiceInputStatus.idle);
  });

  test('a failed transcription says so and adds nothing', () async {
    backend.fails = true;
    await voice.startListening();

    await voice.stopListening();

    expect(voice.transcript, isEmpty);
    expect(voice.notice, VoiceNotice.notTranscribed);
  });

  test('an empty transcript comes back as a notice, not a message', () async {
    await voice.startListening();

    await voice.stopListening();

    expect(voice.transcript, isEmpty);
    expect(voice.notice, VoiceNotice.nothingHeard);
  });

  test('a silent microphone is said so, and nothing is uploaded', () async {
    recorder.captured = (
      wav: Uint8List(44),
      length: const Duration(seconds: 3),
      peak: 0,
    );
    await voice.startListening();

    await voice.stopListening();

    expect(backend.calls, isEmpty);
    expect(voice.notice, VoiceNotice.noSound);
  });

  test('a take with no audio at all is said so too', () async {
    recorder.captured = null;
    await voice.startListening();

    await voice.stopListening();

    expect(backend.calls, isEmpty);
    expect(voice.notice, VoiceNotice.noSound);
  });

  test('send hands over everything heard and empties the transcript', () async {
    backend.replies.add('open a PR');
    await voice.startListening();
    await voice.stopListening();

    final delivered = <String>[];
    await voice.submit((text) async {
      delivered.add(text);
      return true;
    });

    expect(delivered, ['open a PR']);
    expect(voice.transcript, isEmpty);
  });

  test('send mid-sentence ends the take and sends it with the rest', () async {
    backend.replies.addAll(['open a PR', 'for this branch']);
    await voice.startListening();
    await voice.stopListening();
    await voice.startListening();

    final delivered = <String>[];
    await voice.submit((text) async {
      delivered.add(text);
      return true;
    });

    expect(recorder.stops, 2);
    expect(delivered, ['open a PR for this branch']);
  });

  test('a take that fails mid-send sends none of the message', () async {
    backend.replies.add('delete the');
    await voice.startListening();
    await voice.stopListening();
    await voice.startListening();
    backend.fails = true;

    var delivered = false;
    await voice.submit((_) async => delivered = true);

    expect(delivered, isFalse);
    expect(voice.transcript, 'delete the');
    expect(voice.notice, VoiceNotice.notTranscribed);
  });

  test('a send that fails keeps the words for another try', () async {
    backend.replies.add('deploy');
    await voice.startListening();
    await voice.stopListening();

    await voice.submit((_) async => false);

    expect(voice.transcript, 'deploy');
    expect(voice.notice, VoiceNotice.notSent);
    expect(voice.isSending, isFalse);
  });

  group('the retry face, held to talk', () {
    Future<void> failOneSend() async {
      backend.replies.add('deploy');
      await voice.startListening();
      await voice.stopListening();
      await voice.submit((_) async => false);
    }

    test('a quick tap sends the words held from the failed send', () async {
      await failOneSend();
      final delivered = <String>[];
      recorder.captured = (
        wav: Uint8List.fromList([1, 2, 3, 4]),
        length: const Duration(milliseconds: 120),
        peak: 0,
      );

      await voice.startHold((text) async {
        delivered.add(text);
        return true;
      });
      await voice.finishHold((text) async {
        delivered.add(text);
        return true;
      });

      expect(delivered, ['deploy']);
      expect(voice.isIdle, isTrue);
      expect(backend.calls, hasLength(1), reason: 'a tap is not uploaded');
    });

    test('a take that failed still sends none of the message', () async {
      await failOneSend();
      backend.fails = true;
      var delivered = false;

      await voice.startHold((_) async => delivered = true);
      await voice.finishHold((_) async => delivered = true);

      expect(delivered, isFalse, reason: 'what was just said is missing');
      expect(voice.transcript, 'deploy');
    });

    test('a quick tap with nothing held sends nothing', () async {
      recorder.captured = (
        wav: Uint8List.fromList([1, 2, 3, 4]),
        length: const Duration(milliseconds: 120),
        peak: 0,
      );
      var delivered = false;

      await voice.startHold((_) async => delivered = true);
      await voice.finishHold((_) async => delivered = true);

      expect(delivered, isFalse);
      expect(voice.notice, isNull, reason: 'a brushed button is not reported');
    });
  });

  test('clearing mid-transcription drops the words when they arrive', () async {
    backend.pending = Completer<String>();
    await voice.startListening();
    final stopping = voice.stopListening();
    await Future<void>.delayed(Duration.zero);

    voice.clear();
    backend.pending!.complete('never mind');
    await stopping;

    expect(voice.transcript, isEmpty);
    expect(voice.isIdle, isTrue);
  });

  test('clearing while recording throws the recording away', () async {
    await voice.startListening();

    voice.clear();

    expect(recorder.cancels, 1);
    expect(backend.calls, isEmpty);
  });

  test(
    'handing over to the keyboard transcribes the take in progress',
    () async {
      backend.replies.addAll(['rename the', 'module']);
      await voice.startListening();
      await voice.stopListening();
      await voice.startListening();

      expect(await voice.takeTranscript(), 'rename the module');
      expect(voice.transcript, isEmpty);
    },
  );

  test('words already on their way are not handed to the keyboard', () async {
    backend.replies.add('ship it');
    await voice.startListening();
    await voice.stopListening();
    final delivery = Completer<bool>();
    final sending = voice.submit((_) => delivery.future);
    await Future<void>.delayed(Duration.zero);

    expect(await voice.takeTranscript(), isEmpty);

    delivery.complete(true);
    await sending;
  });

  test('a take is heard in the language chosen by the time it ends', () async {
    backend.replies.add('xin chào');
    await voice.startListening();

    language.value = 'vi';
    await voice.stopListening();

    expect(backend.calls.single.lang, 'vi');
  });
}
