// The Harness Store: the shelf is the machines' catalog as cards, a page is
// one harness with Get/Open/Remove per machine, and ratings and reviews come
// from the store API. Pinned: viewers stay off the Discover shelf, Get and
// Remove reach the notifier for the right machine, Remove asks first, and a
// posted review goes to the API with what was typed.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/store/store_controller.dart';
import 'package:harness/store/store_models.dart';
import 'package:harness/store/store_screen.dart';

const _marp = DshEntry(
  id: 'autonomous/marp',
  name: 'Marp',
  engine: 'claude',
  category: 'Slides',
  author: 'Yuki Hattori',
  description: 'Describe a talk; get a keynote.',
  installed: true,
  viewer: true,
  tier: 2,
  repo: 'https://github.com/autonomous-ai/autonomous-marp',
  homepage: 'https://marp.app',
  license: 'MIT',
);
const _typst = DshEntry(
  id: 'autonomous/typst',
  name: 'Typst',
  engine: 'claude',
  category: 'Documents',
  author: 'Typst GmbH',
  description: 'Describe a document; watch the PDF take shape.',
  tier: 2,
);
const _docViewer = DshEntry(
  id: 'autonomous/doc-viewer',
  name: 'Doc Viewer',
  engine: '',
  kind: 'viewer',
  category: 'Documents',
  author: 'Autonomous',
  tier: 2,
);

class _Notifier extends AppNotifier {
  _Notifier()
    : super(config: AppConfig.dev, authSession: AuthSession(), configStore: null);

  final installs = <(String, String)>[];
  final removals = <(String, String)>[];
  int probes = 0;

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {
    probes++;
  }

  @override
  Future<String?> installDsh(String machineId, String id) async {
    installs.add((machineId, id));
    return null;
  }

  @override
  Future<String?> removeDsh(String machineId, String id) async {
    removals.add((machineId, id));
    return null;
  }
}

class _FakeStore implements StoreApi {
  final puts = <(String, int, String?, String?)>[];
  final deletes = <String>[];
  int ratingReads = 0;

  @override
  Future<List<StoreRating>> ratings() async {
    ratingReads++;
    return const [
      StoreRating(harnessId: 'autonomous/marp', average: 4.5, count: 2, histogram: [0, 0, 0, 1, 1]),
    ];
  }

  @override
  Future<StoreReviews> reviews(String harnessId) async {
    if (harnessId != 'autonomous/marp') {
      return StoreReviews(rating: StoreRating.none(harnessId), reviews: const [], mine: null);
    }
    return StoreReviews(
      rating: const StoreRating(harnessId: 'autonomous/marp', average: 4.5, count: 2, histogram: [0, 0, 0, 1, 1]),
      reviews: [
        StoreReview(
          id: 'r1',
          harnessId: 'autonomous/marp',
          rating: 5,
          title: 'Keynote in a minute',
          body: 'The pane is the deck.',
          authorName: 'Ann Lee',
          mine: false,
          updatedAt: DateTime.now(),
        ),
      ],
      mine: null,
    );
  }

  @override
  Future<StoreReview> putReview(String harnessId, {required int rating, String? title, String? body}) async {
    puts.add((harnessId, rating, title, body));
    return StoreReview(
      id: 'mine',
      harnessId: harnessId,
      rating: rating,
      title: title,
      body: body,
      authorName: 'You',
      mine: true,
      updatedAt: DateTime.now(),
    );
  }

  @override
  Future<void> deleteReview(String harnessId) async => deletes.add(harnessId);
}

const _machine = Machine(machineId: 'machine-1', authMode: MachineAuthMode.remote, name: 'studio-mac');

Future<(_Notifier, _FakeStore)> open(WidgetTester tester, {String? initialHarness}) async {
  final notifier = _Notifier();
  addTearDown(notifier.dispose);
  final state = MachineState(_machine)..localOnly = true;
  state.dsh.replace(const [_marp, _typst, _docViewer]);
  notifier.machineStates['machine-1'] = state;
  final store = _FakeStore();
  await tester.pumpWidget(
    MaterialApp(
      home: StoreScreen(notifier: notifier, api: store, source: 'test', initialHarness: initialHarness),
    ),
  );
  await tester.pumpAndSettle();
  return (notifier, store);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the shelf is the catalog as cards, viewers apart, ratings on', (tester) async {
    final (notifier, store) = await open(tester);
    expect(notifier.probes, 1, reason: 'every machine is asked again on open');
    expect(store.ratingReads, 1);
    expect(find.byKey(const ValueKey('store-card:autonomous/marp')), findsOneWidget);
    expect(find.byKey(const ValueKey('store-card:autonomous/typst')), findsOneWidget);
    expect(find.byKey(const ValueKey('store-card:autonomous/doc-viewer')), findsNothing, reason: 'a viewer is not a tile');
    expect(find.text('4.5 · 2'), findsOneWidget);
    expect(find.text('No ratings yet'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('store-shelf-viewers')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('store-card:autonomous/doc-viewer')), findsOneWidget);
    expect(find.byKey(const ValueKey('store-card:autonomous/marp')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('store-shelf-installed')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('store-card:autonomous/marp')), findsOneWidget);
    expect(find.byKey(const ValueKey('store-card:autonomous/typst')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('store-shelf-category:Documents')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('store-card:autonomous/typst')), findsOneWidget);
    expect(find.byKey(const ValueKey('store-card:autonomous/marp')), findsNothing);
  });

  testWidgets('a harness not installed here gets Get, and Get installs on that machine', (tester) async {
    final (notifier, _) = await open(tester);
    await tester.tap(find.byKey(const ValueKey('store-card:autonomous/typst')));
    await tester.pumpAndSettle();
    expect(find.text('Typst GmbH · Documents · Runs on Claude'), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('store-primary-action')), matching: find.text('Get')), findsOneWidget);
    expect(find.text('studio-mac · this computer'), findsOneWidget);
    expect(find.text('Not installed'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('store-get:machine-1')));
    await tester.pumpAndSettle();
    expect(notifier.installs, [('machine-1', 'autonomous/typst')]);
  });

  testWidgets('an installed harness offers Open and Remove; Remove asks, then reaches the daemon', (tester) async {
    final (notifier, _) = await open(tester, initialHarness: 'autonomous/marp');
    expect(find.descendant(of: find.byKey(const ValueKey('store-primary-action')), matching: find.text('Open')), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(const ValueKey('store-machine:machine-1')), matching: find.text('Installed')),
      findsOneWidget,
    );
    expect(find.text('Website'), findsOneWidget);
    expect(find.text('Licence · MIT'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('store-remove:machine-1')));
    await tester.pumpAndSettle();
    expect(find.text('Remove Marp from studio-mac?'), findsOneWidget);
    expect(notifier.removals, isEmpty, reason: 'nothing goes before the person says so');
    await tester.tap(find.byKey(const ValueKey('store-confirm')));
    await tester.pumpAndSettle();
    expect(notifier.removals, [('machine-1', 'autonomous/marp')]);
  });

  testWidgets('reviews load with the page, and a posted review carries the stars and words typed', (tester) async {
    final (_, store) = await open(tester, initialHarness: 'autonomous/marp');
    expect(find.byKey(const ValueKey('store-review:r1')), findsOneWidget);
    expect(find.text('Keynote in a minute'), findsOneWidget);
    expect(find.text('4.5 · 2 ratings'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('store-write-review')));
    await tester.pumpAndSettle();
    expect(find.text('Rate Marp'), findsOneWidget);
    final post = find.byKey(const ValueKey('store-review-post'));
    expect(tester.widget<FilledButton>(post).onPressed, isNull, reason: 'no stars, no post');
    // The fourth star.
    final stars = find.descendant(of: find.byKey(const ValueKey('store-review-stars')), matching: find.byType(Icon));
    await tester.tap(stars.at(3));
    await tester.pump();
    await tester.enterText(find.byKey(const ValueKey('store-review-title')), 'Sharp decks');
    await tester.enterText(find.byKey(const ValueKey('store-review-body')), 'Art takes a while.');
    await tester.tap(post);
    await tester.pumpAndSettle();
    expect(store.puts, [('autonomous/marp', 4, 'Sharp decks', 'Art takes a while.')]);
  });
}
