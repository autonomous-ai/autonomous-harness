// What an engine or a harness is drawn as: the harnesses this build ships a
// face for, the engine each first-party harness runs on, the fallback for an
// id nobody here has heard of, and the mark when its picture will not load.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/widgets/engine_identity.dart';

/// A bundle with no pictures in it: every load fails, as a missing or corrupt
/// asset would.
class _NoPictures extends CachingAssetBundle {
  final asked = <String>[];

  @override
  Future<ByteData> load(String key) async {
    asked.add(key);
    throw FlutterError('no asset $key');
  }
}

void main() {
  test(
    'every first-party harness has a face and a base engine this build knows',
    () {
      final engines = {for (final engine in allEngines) engine.id};
      final harnesses = {for (final harness in knownHarnesses) harness.id};
      expect(harnesses, isNotEmpty);
      for (final harness in knownHarnesses) {
        expect(isHarnessId(harness.id), isTrue, reason: harness.id);
        expect(
          engines,
          isNot(contains(harness.id)),
          reason: 'a harness is never probed as an engine',
        );
        expect(
          harness.asset,
          startsWith('assets/engine-icons/'),
          reason: harness.id,
        );
        expect(harness.creator, isNotEmpty, reason: harness.id);
        expect(harness.category, isNotEmpty, reason: harness.id);
        expect(
          knownHarnessBase[harness.id],
          isNotNull,
          reason: '${harness.id} runs on something',
        );
        expect(identical(engineIdentity(harness.id), harness), isTrue);
      }
      expect(knownHarnessBase.keys.toSet(), harnesses);
      for (final base in knownHarnessBase.values) {
        expect(engines, contains(base));
      }
      expect(knownHarnessBase['autonomous/autonomous-workshop'], 'codex');
      expect(knownHarnessBase['autonomous/marp'], 'claude');
      expect(
        engineIdentity('autonomous/text-to-cad').detail,
        'CAD · Jake Fitzgerald',
      );
      expect(
        engineIdentity(' Codex ').label,
        'Codex',
        reason: 'ids are trimmed and case-folded',
      );
    },
  );

  test('every agent package in the store has its face in this build', () {
    // A package without one draws an initial in its tab, pane header and store
    // card while every package beside it wears its logo.
    final agents = Directory('../store/agents')
        .listSync()
        .whereType<Directory>()
        .where((dir) => File('${dir.path}/harness.json').existsSync())
        .map(
          (dir) =>
              'autonomous/${dir.uri.pathSegments.where((s) => s.isNotEmpty).last}',
        )
        .toList();
    expect(agents, isNotEmpty);
    final faces = {for (final harness in knownHarnesses) harness.id};
    // Projects that publish no logo draw their initial rather than a mark made
    // up for them. Godogen's repository has no image of its own; the five
    // below neither, and the logos they sit beside (Ableton, JUCE, OpenFOAM,
    // SUMO) belong to other companies.
    const noLogo = {
      'autonomous/godogen',
      'autonomous/ableton-ai',
      'autonomous/autoresearch-mlx',
      'autonomous/foam-agent',
      'autonomous/juce-agent-toolkit',
      'autonomous/simskill',
    };
    for (final id in agents.where((id) => !noLogo.contains(id))) {
      expect(faces, contains(id), reason: '$id has no EngineIdentity');
      final asset = engineIdentity(id).asset!;
      expect(
        File(asset).existsSync(),
        isTrue,
        reason: '$id: $asset is missing',
      );
    }
  });

  test("this build's words for a harness are the store's own", () {
    // Before a machine answers, or when its CLI predates taglines, the agent
    // search reads these: "MuJoCo by Google DeepMind", "Advanced physics
    // simulation". They must say what the Store says once it does answer.
    var checked = 0;
    for (final dir in Directory(
      '../store/agents',
    ).listSync().whereType<Directory>()) {
      final manifest = File('${dir.path}/harness.json');
      if (!manifest.existsSync()) continue;
      final id = jsonDecode(manifest.readAsStringSync())['id'] as String;
      if (!knownHarnesses.any((harness) => harness.id == id)) continue;
      final facts = File('${dir.path}/store.json');
      final Map<String, dynamic> store = facts.existsSync()
          ? jsonDecode(facts.readAsStringSync()) as Map<String, dynamic>
          : const {};
      final Map<String, dynamic> package =
          jsonDecode(manifest.readAsStringSync()) as Map<String, dynamic>;
      final identity = engineIdentity(id);
      expect(identity.tagline, store['tagline'], reason: '$id tagline');
      expect(identity.creator, package['author'], reason: '$id author');
      expect(identity.category, package['category'], reason: '$id category');
      checked++;
    }
    expect(checked, knownHarnesses.length);
    for (final engine in allEngines) {
      expect(engine.tagline, isNotEmpty, reason: engine.id);
      expect(engine.tagline!.length, lessThanOrEqualTo(80), reason: engine.id);
    }
  });

  test('an id nobody here knows still gets a name, never its owner', () {
    expect(isHarnessId(null), isFalse);
    expect(isHarnessId('claude'), isFalse);
    final arm = engineIdentity('someone/robot-arm');
    expect(arm.id, 'someone/robot-arm');
    expect(arm.label, 'Robot-arm');
    expect(arm.asset, isNull);
    expect(arm.detail, isNull);
    expect(
      engineIdentity('someone/robot-arm', displayName: '  Arm  ').label,
      'Arm',
    );
    expect(engineIdentity('someone/').label, 'Agent');
    expect(engineIdentity('aider').label, 'Aider');
    final nothing = engineIdentity(null, displayName: '   ');
    expect(nothing.id, 'unknown');
    expect(nothing.label, 'Agent');
  });

  test('an agent is drawn as its harness when it came from one', () {
    const plain = Agent(id: 'a', name: 'A', engine: 'codex');
    expect(agentIdentity(plain).label, 'Codex');
    const circuit = Agent(
      id: 'c',
      name: 'C',
      engine: 'claude',
      dsh: 'autonomous/autonomous-circuit',
      dshName: 'Autonomous Circuit',
    );
    expect(agentIdentity(circuit).id, 'autonomous/autonomous-circuit');
    final mark = EngineMark.forAgent(circuit, size: 20, enabled: false);
    expect(mark.engine, 'autonomous/autonomous-circuit');
    expect(mark.displayName, 'Autonomous Circuit');
  });

  testWidgets('a mark whose picture will not load draws its initial instead', (
    tester,
  ) async {
    final bundle = _NoPictures();
    await tester.pumpWidget(
      MaterialApp(
        home: DefaultAssetBundle(
          bundle: bundle,
          child: const Center(
            child: EngineMark(engine: 'autonomous/marp', size: 24),
          ),
        ),
      ),
    );
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pump();
    expect(bundle.asked, isNotEmpty, reason: 'the picture was asked for');
    final fallback = find.byKey(
      const ValueKey('engine-fallback-autonomous/marp'),
    );
    expect(fallback, findsOneWidget);
    expect(
      find.descendant(of: fallback, matching: find.text('M')),
      findsOneWidget,
    );
  });
}
