import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_select_field.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/store/store_controller.dart';
import 'package:harness/store/store_editorial.dart';
import 'package:harness/store/store_models.dart';
import 'package:harness/store/store_screen.dart';

import 'support/real_fonts.dart';

final _catalog = [
  for (final (id, name, category) in [
    ('blender', 'Blender', '3D'),
    ('copper', 'Copper', 'PCB'),
    ('text-to-cad', 'text-to-cad', 'CAD'),
    ('phaser', 'Phaser', 'Games'),
    ('strudel', 'Strudel', 'Music'),
    ('mujoco', 'MuJoCo', 'Simulation'),
    ('marp', 'Marp', 'Slides'),
    ('manim', 'Manim', 'Math animation'),
    ('excalidraw', 'Excalidraw', 'Diagrams'),
    ('marimo', 'marimo', 'Notebooks'),
    ('typst', 'Typst', 'Documents'),
    ('remotion', 'Remotion', 'Video'),
    ('circuitjs', 'CircuitJS', 'Circuits'),
    ('rdkit', 'RDKit', 'Chemistry'),
    ('yosys', 'Yosys', 'Chips'),
  ])
    DshEntry(
      id: 'autonomous/$id',
      name: name,
      engine: 'claude',
      category: category,
      installed: ['blender', 'copper', 'marp'].contains(id),
    ),
];

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {}
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
}

class _Api implements StoreApi {
  _Api({this.unavailable = false});
  final bool unavailable;
  @override
  Future<List<StoreRating>> ratings() async {
    if (unavailable) throw StateError('service unavailable');
    return [];
  }

  @override
  Future<StoreReviews> reviews(String harnessId) async {
    if (unavailable) throw StateError('service unavailable');
    return StoreReviews(
      rating: StoreRating.none(harnessId),
      reviews: [],
      mine: null,
    );
  }

  @override
  Future<void> deleteReview(String harnessId) async {}
  @override
  Future<StoreReview> putReview(
    String harnessId, {
    required int rating,
    String? title,
    String? body,
  }) => throw UnimplementedError();
}

Future<(_App, GlobalKey)> _open(
  WidgetTester tester, {
  List<DshEntry>? entries,
  String? initialHarness,
  bool unavailable = false,
  double width = 1440,
  double height = 1000,
  double scale = 1,
  Brightness brightness = Brightness.dark,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, height);
  addTearDown(tester.view.reset);
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  final app = _App();
  addTearDown(app.dispose);
  final local =
      MachineState(
          const Machine(
            machineId: 'local',
            authMode: MachineAuthMode.remote,
            name: 'Studio',
          ),
        )
        ..localOnly = true
        ..nodeOnline = true;
  local.dsh.replace(entries ?? _catalog);
  local.engines.replace(const [
    EngineAvailability(engine: 'codex', installed: true),
    EngineAvailability(engine: 'claude', installed: true),
  ]);
  app.machineStates['local'] = local;
  app.openStore();
  final key = GlobalKey();
  await tester.pumpWidget(
    RepaintBoundary(
      key: key,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Scaffold(
          body: StoreTab(
            notifier: app,
            api: _Api(unavailable: unavailable),
            initialHarness: initialHarness,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.runAsync(() async {
    final context = tester.element(find.byType(StoreTab));
    for (final asset in [
      'blender-studio.png',
      'copper-board.png',
      'phaser-bricks.png',
    ]) {
      await precacheImage(AssetImage('assets/store/$asset'), context);
    }
  });
  await tester.pumpAndSettle();
  return (app, key);
}

Future<void> _capture(WidgetTester tester, GlobalKey key, String name) async {
  final output = Platform.environment['HARNESS_STORE_CAPTURE_DIR'];
  if (output == null) return;
  await tester.runAsync(() async {
    final image =
        await (key.currentContext!.findRenderObject()! as RenderRepaintBoundary)
            .toImage(pixelRatio: 1);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(output).create(recursive: true);
    await File('$output/$name.png').writeAsBytes(data!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide300')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
          ),
        ))
        .load();
  });

  for (final (width, height, scale, brightness) in [
    (1440.0, 1080.0, 1.0, Brightness.dark),
    (1440.0, 1080.0, 1.0, Brightness.light),
    (1000.0, 850.0, 1.0, Brightness.dark),
    (760.0, 900.0, 1.5, Brightness.dark),
  ]) {
    testWidgets('Discover fits $width with scale $scale in ${brightness.name}', (
      tester,
    ) async {
      final (_, key) = await _open(
        tester,
        width: width,
        height: height,
        scale: scale,
        brightness: brightness,
      );
      expect(
        find.byKey(const ValueKey('store-feature:autonomous/blender')),
        findsOneWidget,
      );
      expect(find.text('No ratings yet'), findsNothing);
      expect(
        find.byKey(const ValueKey('store-shelf-category:3D')),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
      await _capture(
        tester,
        key,
        'discover-${width.toInt()}-${brightness.name}-${scale.toStringAsFixed(1)}',
      );
    });
  }

  testWidgets(
    'collections lead to their live catalog and search finds capabilities',
    (tester) async {
      await _open(tester);
      await tester.tap(find.byKey(const ValueKey('store-collection:hardware')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-card:autonomous/copper')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('store-card:autonomous/blender')),
        findsNothing,
      );
      await tester.enterText(
        find.byKey(const ValueKey('store-search')),
        'circuit board',
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-card:autonomous/copper')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('store-card:codex')), findsNothing);
      await tester.enterText(
        find.byKey(const ValueKey('store-search')),
        'does-not-exist',
      );
      await tester.pumpAndSettle();
      expect(
        find.text(
          'No matching harnesses. Try a name or something you want to make.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('store-feature:autonomous/blender')),
        findsOneWidget,
      );
    },
  );

  testWidgets('feature opens its page and a starter prompt can be copied', (
    tester,
  ) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String;
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    final (_, key) = await _open(tester);
    await tester.tap(find.text('Explore').first);
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('store-page:autonomous/blender')),
      findsOneWidget,
    );
    expect(find.text('Start with an idea'), findsOneWidget);
    await _capture(tester, key, 'blender-detail');
    final copy = find.byKey(const ValueKey('store-copy-prompt:0'));
    await tester.ensureVisible(copy);
    await tester.pumpAndSettle();
    await tester.tap(copy);
    await tester.pumpAndSettle();
    expect(copied, storeStories['autonomous/blender']!.prompts.first);
    expect(find.text('Prompt copied'), findsOneWidget);
  });

  testWidgets(
    'unavailable reviews do not become a release notice in discovery or detail',
    (tester) async {
      await _open(tester, unavailable: true);
      expect(find.textContaining('not available'), findsNothing);
      await tester.tap(find.text('Explore').first);
      await tester.pumpAndSettle();
      expect(find.text('Ratings and reviews'), findsNothing);
      expect(find.text('No ratings yet'), findsNothing);
      expect(
        find.byKey(const ValueKey('store-primary-action')),
        findsOneWidget,
      );
    },
  );

  testWidgets('missing featured packages are not advertised', (tester) async {
    await _open(tester, entries: []);
    expect(
      find.byKey(const ValueKey('store-feature:autonomous/blender')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('store-collection:hardware')),
      findsNothing,
    );
    expect(find.text('Coding engines'), findsOneWidget);
    expect(find.byKey(const ValueKey('store-card:codex')), findsOneWidget);
  });

  testWidgets(
    'Open launches the installed harness and cancel abandons only its draft',
    (tester) async {
      final (app, _) = await _open(tester);
      await tester.tap(find.byKey(const ValueKey('store-shelf-installed')));
      await tester.pumpAndSettle();
      final count = app.swarms.length;
      await tester.tap(
        find.byKey(const ValueKey('store-action:autonomous/blender')),
      );
      await tester.pumpAndSettle();
      expect(find.text('New Harness'), findsOneWidget);
      expect(
        tester
            .widget<AppSelectField<String>>(
              find.byKey(const Key('new-agent-engine-field')),
            )
            .value,
        'autonomous/blender',
      );
      expect(app.swarms.length, count + 1);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(app.swarms.length, count);
    },
  );
}
