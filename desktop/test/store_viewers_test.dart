// The store's quieter surfaces, as widgets on their own: the Viewers page
// (shared previews and the agents that use them), a listing row for a viewer
// package, and a Discover collection whose harnesses have no artwork.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/store/store_discover.dart';
import 'package:harness/store/store_editorial.dart';
import 'package:harness/store/store_models.dart';
import 'package:harness/store/store_viewers.dart';
import 'package:harness/widgets/engine_identity.dart';

const _cadViewer = DshEntry(
  id: 'autonomous/cad-viewer',
  name: 'CAD Viewer',
  engine: '',
  kind: 'viewer',
  description: 'STEP, STL and URDF, in a pane.',
);

Future<void> _show(WidgetTester tester, Widget child) =>
    tester.pumpWidget(MaterialApp(home: Scaffold(body: child)));

void main() {
  testWidgets('no viewers: still asking, or asked and none', (tester) async {
    Widget page({required bool loaded}) => StoreViewers(
      viewers: const [],
      agents: const [],
      installedOn: (_) => const [],
      onOpenAgent: (_) {},
      loaded: loaded,
    );
    await _show(tester, page(loaded: false));
    expect(find.text('Asking this computer…'), findsOneWidget);
    await _show(tester, page(loaded: true));
    expect(find.text('No viewers reported by this computer.'), findsOneWidget);
  });

  testWidgets(
    'a viewer says what it is, where it is, and which agents use it, once each and by name',
    (tester) async {
      final opened = <String>[];
      const docViewer = DshEntry(
        id: 'autonomous/doc-viewer',
        name: 'Doc Viewer',
        engine: '',
        kind: 'viewer',
      );
      await _show(
        tester,
        StoreViewers(
          viewers: const [_cadViewer, docViewer],
          agents: const [
            DshEntry(
              id: 'someone/zeta-arm',
              name: 'Zeta arm',
              engine: 'claude',
              viewerUse: 'autonomous/cad-viewer',
            ),
            DshEntry(
              id: 'autonomous/text-to-cad',
              name: 'text-to-cad',
              engine: 'claude',
              viewerUse: 'autonomous/cad-viewer',
            ),
            // The same agent as another machine reported it.
            DshEntry(
              id: 'autonomous/text-to-cad',
              name: 'text-to-cad',
              engine: 'claude',
              viewerUse: 'autonomous/cad-viewer',
            ),
            // A viewer never uses a viewer.
            DshEntry(
              id: 'autonomous/web-viewer',
              name: 'Web Viewer',
              engine: '',
              kind: 'viewer',
              viewerUse: 'autonomous/cad-viewer',
            ),
          ],
          installedOn: (id) =>
              id == _cadViewer.id ? const ['studio-mac', 'lab-box'] : const [],
          onOpenAgent: opened.add,
          loaded: true,
        ),
      );
      final cad = find.byKey(
        const ValueKey('store-viewer:autonomous/cad-viewer'),
      );
      expect(
        find.descendant(
          of: cad,
          matching: find.text('STEP, STL and URDF, in a pane.'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: cad,
          matching: find.text('Installed on studio-mac, lab-box'),
        ),
        findsOneWidget,
      );
      final users = tester
          .widgetList<TextButton>(
            find.descendant(of: cad, matching: find.byType(TextButton)),
          )
          .map((button) => (button.child! as Text).data)
          .toList();
      expect(users, ['View', 'text-to-cad', 'Zeta arm']);
      await tester.tap(
        find.byKey(const ValueKey('store-viewer-action:autonomous/cad-viewer')),
      );
      expect(opened, ['autonomous/cad-viewer']);
      opened.clear();
      await tester.tap(
        find.byKey(
          const ValueKey(
            'store-viewer-agent:autonomous/cad-viewer:someone/zeta-arm',
          ),
        ),
      );
      expect(opened, ['someone/zeta-arm']);

      final doc = find.byKey(
        const ValueKey('store-viewer:autonomous/doc-viewer'),
      );
      expect(
        find.descendant(of: doc, matching: find.text('Not installed')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: doc,
          matching: find.text('No agents reported in this catalog.'),
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets('a viewer package in a listing is viewed, never got or opened', (
    tester,
  ) async {
    final opened = <String>[];
    final acted = <String>[];
    await _show(
      tester,
      StoreListing(
        entries: const [_cadViewer],
        ratingFor: (entry) => StoreRating.none(entry.id),
        installed: (_) => true,
        onOpen: opened.add,
        onAction: (entry) => acted.add(entry.id),
      ),
    );
    final action = find.byKey(
      const ValueKey('store-action:autonomous/cad-viewer'),
    );
    expect(
      find.descendant(of: action, matching: find.text('View')),
      findsOneWidget,
    );
    await tester.tap(action);
    expect(opened, ['autonomous/cad-viewer']);
    expect(acted, isEmpty);
  });

  testWidgets(
    'a collection whose harnesses have no artwork wears the first one\'s mark',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1200, 1400);
      addTearDown(tester.view.reset);
      StoreCollection? picked;
      await _show(
        tester,
        StoreDiscover(
          entries: const [
            DshEntry(
              id: 'autonomous/strudel',
              name: 'Strudel',
              engine: 'claude',
              category: 'Music',
            ),
          ],
          loaded: true,
          ratingFor: (entry) => StoreRating.none(entry.id),
          installed: (_) => false,
          onOpen: (_) {},
          onAction: (_) {},
          onCollection: (collection) => picked = collection,
          onAll: () {},
          onEngines: () {},
        ),
      );
      final play = find.byKey(const ValueKey('store-collection:play'));
      expect(play, findsOneWidget);
      expect(
        find.descendant(of: play, matching: find.byType(EngineMark)),
        findsOneWidget,
      );
      expect(
        tester
            .widget<EngineMark>(
              find.descendant(of: play, matching: find.byType(EngineMark)),
            )
            .engine,
        'autonomous/strudel',
      );
      expect(
        find.descendant(of: play, matching: find.text('1 harness to explore')),
        findsOneWidget,
      );
      await tester.tap(play);
      expect(picked?.id, 'play');
    },
  );
}
