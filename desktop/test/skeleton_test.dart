// The skeleton primitives, checked against the four rules they exist for:
// the rhythm is a breath that Reduce Motion freezes at the PEAK, a text
// placeholder is exactly as tall as the text it stands in for, a list fades
// towards its bottom, and none of it takes the pointer.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/widgets/pulse.dart';
import 'package:harness/shared/widgets/skeleton.dart';

Widget _host(Widget child, {bool reduceMotion = false}) => MediaQuery(
  data: MediaQueryData(disableAnimations: reduceMotion),
  child: Directionality(
    textDirection: TextDirection.ltr,
    child: Center(child: child),
  ),
);

Color _fillOf(WidgetTester tester) {
  final box = tester.widget<Container>(
    find.descendant(of: find.byType(Pulse), matching: find.byType(Container)),
  );
  return (box.decoration! as BoxDecoration).color!;
}

void main() {
  testWidgets('breathes between recess and recessHover', (tester) async {
    await tester.pumpWidget(_host(const Skeleton(width: 40)));
    // The first frame is at rest.
    expect(_fillOf(tester), AppSurface.recess);
    // Half a cycle later it has reached the peak.
    await tester.pump(const Duration(milliseconds: 1100));
    expect(_fillOf(tester), AppSurface.recessHover);
    // And it comes back down: a breath, not a one-shot fade.
    await tester.pump(const Duration(milliseconds: 1100));
    expect(_fillOf(tester), AppSurface.recess);
  });

  testWidgets('Reduce Motion holds the skeleton at the peak, not the middle', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(const Skeleton(width: 40), reduceMotion: true),
    );
    expect(_fillOf(tester), AppSurface.recessHover);
    await tester.pump(const Duration(milliseconds: 550));
    expect(_fillOf(tester), AppSurface.recessHover);
  });

  testWidgets('Skeleton.circle is round and a text line is not', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        const Row(
          mainAxisSize: MainAxisSize.min,
          children: [Skeleton.circle(size: 16), Skeleton.text(width: 40)],
        ),
      ),
    );
    final boxes = tester
        .widgetList<Container>(find.byType(Container))
        .map((c) => c.decoration! as BoxDecoration)
        .toList();
    expect(boxes[0].shape, BoxShape.circle);
    expect(boxes[1].shape, BoxShape.rectangle);
    expect(boxes[1].borderRadius, BorderRadius.circular(4));
  });

  testWidgets('SkeletonText is exactly as tall as the text it replaces', (
    tester,
  ) async {
    const style = TextStyle(fontSize: 13.7, height: 1.25);
    const strut = StrutStyle(
      fontSize: 13.5,
      height: 1.25,
      forceStrutHeight: true,
    );
    await tester.pumpWidget(
      _host(
        const Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Real row', key: Key('real'), style: style, strutStyle: strut),
            SkeletonText(
              key: Key('fake'),
              style: style,
              strutStyle: strut,
              width: 60,
            ),
            Text(
              'Plain',
              key: Key('real-plain'),
              style: TextStyle(fontSize: 11),
            ),
            SkeletonText(
              key: Key('fake-plain'),
              style: TextStyle(fontSize: 11),
              width: 60,
            ),
          ],
        ),
      ),
    );
    expect(
      tester.getSize(find.byKey(const Key('fake'))).height,
      tester.getSize(find.byKey(const Key('real'))).height,
    );
    expect(
      tester.getSize(find.byKey(const Key('fake-plain'))).height,
      tester.getSize(find.byKey(const Key('real-plain'))).height,
    );
  });

  testWidgets('SkeletonText honours the ambient text scale', (tester) async {
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(textScaler: TextScaler.linear(1.5)),
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: const [
                Text(
                  'Scaled',
                  key: Key('real'),
                  style: TextStyle(fontSize: 12),
                ),
                SkeletonText(
                  key: Key('fake'),
                  style: TextStyle(fontSize: 12),
                  width: 40,
                ),
              ],
            ),
          ),
        ),
      ),
    );
    expect(
      tester.getSize(find.byKey(const Key('fake'))).height,
      tester.getSize(find.byKey(const Key('real'))).height,
    );
  });

  testWidgets('SkeletonList fades towards the bottom and ignores the pointer', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(const SizedBox(width: 200, child: SkeletonList(rows: 4))),
    );
    final opacities = tester
        .widgetList<Opacity>(
          find.descendant(
            of: find.byType(SkeletonList),
            matching: find.byType(Opacity),
          ),
        )
        .map((o) => o.opacity)
        .toList();
    expect(opacities, [1.0, 1 - 0.65 / 4, 1 - 0.65 / 2, 1 - 0.65 * 3 / 4]);
    // Row widths differ — a column of equal bars is one grey slab.
    final factors = tester
        .widgetList<SkeletonLine>(find.byType(SkeletonLine))
        .map((l) => l.widthFactor)
        .toSet();
    expect(factors.length, greaterThan(1));
    expect(
      find.descendant(
        of: find.byType(SkeletonList),
        matching: find.byType(IgnorePointer),
      ),
      findsWidgets,
    );
    final scroll = tester.widget<SingleChildScrollView>(
      find.byType(SingleChildScrollView),
    );
    expect(scroll.physics, isA<NeverScrollableScrollPhysics>());
  });

  test('skeletonFade never drops below the depth floor', () {
    expect(skeletonFade(0, 5), 1);
    expect(skeletonFade(4, 5), closeTo(1 - 0.8 * 0.65, 1e-9));
    expect(
      skeletonFade(2, 3, depth: skeletonFadeLight),
      closeTo(1 - 2 / 3 * 0.5, 1e-9),
    );
    expect(skeletonFade(0, 0), 1);
  });
}
