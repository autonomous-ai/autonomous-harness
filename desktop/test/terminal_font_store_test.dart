import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/terminal/terminal_typography.dart';

/// An in-memory store that can be told to fail, so the recovery paths are
/// exercised rather than assumed.
class _FakeStore implements LocalKeyValueStore {
  final Map<String, String> values = {};
  bool broken = false;

  @override
  Future<String?> read(String key) async {
    if (broken) throw StateError('unreadable');
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    if (broken) throw StateError('unwritable');
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  test('defaults to SF Mono at the default size', () async {
    final store = TerminalFontStore(storage: _FakeStore());
    await store.load();

    expect(store.family, TerminalFontChoice.defaultForPlatform);
    expect(store.size, terminalFontSize);
  });

  test('remembers a family and size by name, not by ordinal', () async {
    final storage = _FakeStore();
    final store = TerminalFontStore(storage: storage);
    await store.setFamily(TerminalFontChoice.menlo);
    await store.setSize(16);

    // An enum's index is a detail of the order its cases happen to be written
    // in, and a file on disk outlives that order.
    expect(storage.values['terminal_font_family'], 'menlo');
    expect(storage.values['terminal_font_size'], '16.0');

    final reopened = TerminalFontStore(storage: storage);
    await reopened.load();
    expect(reopened.family, TerminalFontChoice.menlo);
    expect(reopened.size, 16.0);
  });

  test('size is clamped at both ends', () async {
    final store = TerminalFontStore(storage: _FakeStore());
    await store.setSize(1000);
    expect(store.size, 22.0);
    await store.setSize(-1000);
    expect(store.size, 9.0);
  });

  test('reset restores SF Mono at the default size', () async {
    final store = TerminalFontStore(storage: _FakeStore());
    await store.setFamily(TerminalFontChoice.courierNew);
    await store.setSize(20);

    await store.reset();

    expect(store.family, TerminalFontChoice.defaultForPlatform);
    expect(store.size, terminalFontSize);
  });

  test('increase/decrease step by 1pt and clamp', () async {
    final store = TerminalFontStore(storage: _FakeStore());
    await store.setSize(9);
    await store.decreaseSize();
    expect(store.size, 9.0); // already at the floor

    await store.setSize(22);
    await store.increaseSize();
    expect(store.size, 22.0); // already at the ceiling

    await store.setSize(13);
    await store.increaseSize();
    expect(store.size, 14.0);
    await store.decreaseSize();
    expect(store.size, 13.0);
  });

  test(
    'the same (family, size) always yields the identical TerminalStyle object',
    () async {
      // TerminalStyle has no == override, and the vendored renderer's own
      // setters (RenderTerminal.textStyle, TerminalPainter.textStyle) guard
      // on == before doing any work — a fresh instance per rebuild would
      // spuriously re-layout (and re-resize) the terminal on every rebuild.
      final store = TerminalFontStore(storage: _FakeStore());
      await store.setFamily(TerminalFontChoice.monaco);
      await store.setSize(15);
      final first = store.value;

      await store.setFamily(TerminalFontChoice.defaultForPlatform);
      await store.setFamily(TerminalFontChoice.monaco);
      await store.setSize(15);

      expect(identical(store.value, first), isTrue);
    },
  );

  test(
    'an unreadable state file costs the preference, not the launch',
    () async {
      final storage = _FakeStore()..broken = true;
      final store = TerminalFontStore(storage: storage);

      await store.load();

      expect(store.family, TerminalFontChoice.defaultForPlatform);
      expect(store.size, terminalFontSize);
    },
  );

  test('the terminal moves even when the disk refuses', () async {
    final store = TerminalFontStore(storage: _FakeStore()..broken = true);

    await store.setFamily(TerminalFontChoice.menlo);

    expect(store.family, TerminalFontChoice.menlo);
  });

  test(
    'an unknown saved family name falls back rather than throwing',
    () async {
      final storage = _FakeStore()
        ..values['terminal_font_family'] = 'comic-sans';
      final store = TerminalFontStore(storage: storage);

      await store.load();

      expect(store.family, TerminalFontChoice.defaultForPlatform);
    },
  );
}
