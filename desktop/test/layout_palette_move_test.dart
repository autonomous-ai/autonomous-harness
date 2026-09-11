// Walking the layout strip with the keys.
//
// Reported from the desk, and both halves are pinned here: pressing UP or DOWN
// walked sideways, and nothing wrapped. The first is worse than a key that waits
// — the motion did not match the arrow on the cap — and the second is the same
// dead press the window's pane ring was changed to remove.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/layout_palette.dart';

/// Four shapes to a line, which is what a 500px palette fits.
const _perRow = 4;

int _left(int at, int n) => layoutPaletteMove(at, n, -1, 0, _perRow);
int _right(int at, int n) => layoutPaletteMove(at, n, 1, 0, _perRow);
int _up(int at, int n) => layoutPaletteMove(at, n, 0, -1, _perRow);
int _down(int at, int n) => layoutPaletteMove(at, n, 0, 1, _perRow);

void main() {
  group('left and right step, and come round', () {
    test('one along', () {
      expect(_right(0, 4), 1);
      expect(_left(2, 4), 1);
    });

    test('off the right end appears at the left', () {
      expect(_right(3, 4), 0);
    });

    test('off the left end appears at the right', () {
      expect(_left(0, 4), 3);
    });

    test('a lap of the whole strip comes home', () {
      var at = 0;
      for (var i = 0; i < 4; i++) {
        at = _right(at, 4);
      }
      expect(at, 0);
    });
  });

  group('up and down are VERTICAL', () {
    // Six shapes at four to a line: [0 1 2 3] over [4 5].
    test('down moves to the shape UNDER this one, not the next one along', () {
      expect(_down(1, 6), 5);
    });

    test('up moves to the shape above', () {
      expect(_up(5, 6), 1);
    });

    test('a column with no shape under it clamps to the last', () {
      // Column 3 of row 0 has nothing beneath it on a row of two.
      expect(_down(3, 6), 5);
    });

    test('down off the bottom row comes back to the top', () {
      expect(_down(4, 6), 0);
    });

    test('up off the top row comes back to the bottom', () {
      expect(_up(0, 6), 4);
    });
  });

  group('a single line has no up and no down', () {
    // The case the old scheme was built around — and the reason it made every
    // key step sideways. Waiting is the honest answer; walking sideways is not.
    test('down does nothing', () => expect(_down(1, 4), 1));
    test('up does nothing', () => expect(_up(1, 4), 1));
    test('left and right still work', () {
      expect(_right(1, 4), 2);
      expect(_left(1, 4), 0);
    });
  });

  group('degenerate strips', () {
    test('one shape is the only answer, whichever key is pressed', () {
      for (final at in [_left(0, 1), _right(0, 1), _up(0, 1), _down(0, 1)]) {
        expect(at, 0);
      }
    });

    test('an empty strip never returns an index into it', () {
      expect(_right(0, 0), 0);
    });
  });
}
