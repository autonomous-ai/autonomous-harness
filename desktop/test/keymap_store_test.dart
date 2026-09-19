import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_store.dart';

String config(String command) => jsonEncode({
  'bindings': [
    {'keys': 'cmd+t', 'command': command},
  ],
});
KeymapStore storeFor(File file, {bool watch = false}) => KeymapStore(
  file: file,
  watchFiles: watch,
  defaults: [
    KeyBinding(keys: [KeyStroke.parse('cmd+t')], command: 'swarm.new'),
  ],
  commands: {'swarm.new', 'pane.focus_left'},
);
String? selected(KeymapStore store) => store.current.match(
  KeymapContext.terminal,
  [KeyStroke.parse('cmd+t')],
).command;

Future<void> eventually(bool Function() condition) async {
  final until = DateTime.now().add(const Duration(seconds: 5));
  while (!condition()) {
    if (DateTime.now().isAfter(until)) {
      fail('Directory watch did not publish the expected keymap');
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

class _ControlledFile extends Fake implements File {
  final reads = <StreamController<List<int>>>[];
  @override
  Stream<List<int>> openRead([int? start, int? end]) {
    final controller = StreamController<List<int>>();
    reads.add(controller);
    return controller.stream;
  }
}

void main() {
  late Directory directory;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('harness-keymap-test-');
  });
  tearDown(() async {
    await directory.delete(recursive: true);
  });

  test('missing file uses defaults without creating a user config', () async {
    final file = File('${directory.path}/config/keybindings.jsonc');
    final store = storeFor(file);
    addTearDown(store.dispose);
    await store.start();
    expect(selected(store), 'swarm.new');
    expect(store.error, isNull);
    expect(await file.parent.exists(), false);
    expect(store.revision, 0);
  });

  test(
    'invalid edit retains working bindings; repair and removal recover',
    () async {
      final file = File('${directory.path}/keybindings.jsonc');
      final store = storeFor(file);
      addTearDown(store.dispose);
      var changes = 0;
      store.addListener(() => changes++);
      await file.writeAsString(config('pane.focus_left'));
      await store.start();
      expect(selected(store), 'pane.focus_left');
      final good = store.current;
      final revision = store.revision;
      await file.writeAsString('{');
      await store.reload();
      expect(store.current, same(good));
      expect(store.revision, revision);
      expect(store.error, contains('FormatException'));
      await file.writeAsString(
        '// comments only change\n${config('pane.focus_left')}',
      );
      await store.reload();
      expect(store.current, same(good));
      expect(store.error, isNull);
      expect(changes, 3); // New map, diagnostic, diagnostic cleared.
      await file.delete();
      await store.reload();
      expect(selected(store), 'swarm.new');
    },
  );

  test('a slower old read cannot overwrite a newer map or error', () async {
    final file = _ControlledFile();
    final store = storeFor(file);
    addTearDown(store.dispose);
    final first = store.reload();
    final second = store.reload();
    file.reads[1].add(utf8.encode(config('pane.focus_left')));
    await file.reads[1].close();
    await second;
    file.reads[0].add(utf8.encode('{'));
    await file.reads[0].close();
    await first;
    expect(selected(store), 'pane.focus_left');
    expect(store.error, isNull);
  });

  test('oversized and malformed UTF-8 files retain the current map', () async {
    final file = File('${directory.path}/keybindings.jsonc');
    final store = storeFor(file);
    addTearDown(store.dispose);
    await store.start();
    final good = store.current;
    await file.writeAsBytes(List.filled(KeymapStore.maximumBytes + 1, 32));
    await store.reload();
    expect(store.error, contains('128 KiB'));
    expect(store.current, same(good));
    await file.writeAsBytes([0xff]);
    await store.reload();
    expect(store.error, isNotNull);
    expect(store.current, same(good));
  });

  test(
    'explicit open creates a template and preserves existing file contents',
    () async {
      final file = File('${directory.path}/config/keybindings.jsonc');
      final store = storeFor(file);
      addTearDown(store.dispose);
      await store.ensureFile();
      expect(await file.readAsString(), contains('Defaults are inherited'));
      final customized = config('pane.focus_left');
      await file.writeAsString(customized);
      await store.ensureFile();
      expect(await file.readAsString(), customized);
      expect(selected(store), 'pane.focus_left');
    },
  );

  test(
    'watch discovers a new directory and an editor atomic replacement',
    () async {
      final file = File('${directory.path}/config/keybindings.jsonc');
      final store = storeFor(file, watch: true);
      addTearDown(store.dispose);
      await store.start();
      await file.parent.create();
      await file.writeAsString(config('pane.focus_left'));
      await eventually(() => selected(store) == 'pane.focus_left');
      final replacement = File('${file.path}.save');
      await replacement.writeAsString(config('swarm.new'));
      await replacement.rename(file.path);
      await eventually(() => selected(store) == 'swarm.new');
      expect(store.error, isNull);
    },
  );

  test(
    'watch follows a dotfiles symlink and its replacement target',
    () async {
      final first = File('${directory.path}/repo1/keys.jsonc');
      final second = File('${directory.path}/repo2/keys.jsonc');
      await first.parent.create();
      await second.parent.create();
      await first.writeAsString(config('swarm.new'));
      await second.writeAsString(config('pane.focus_left'));
      final link = Link('${directory.path}/app/keybindings.jsonc');
      await Directory('${directory.path}/app').create();
      await link.create(first.path);
      final store = storeFor(File(link.path), watch: true);
      addTearDown(store.dispose);
      await store.start();
      await link.update(second.path);
      await eventually(() => selected(store) == 'pane.focus_left');
      final replacement = File('${second.path}.save');
      await replacement.writeAsString(config('swarm.new'));
      await replacement.rename(second.path);
      await eventually(() => selected(store) == 'swarm.new');
    },
    skip: Platform.isWindows
        ? 'Creating Windows symlinks requires host permission'
        : false,
  );

  test('configuration path follows XDG and rejects a relative XDG root', () {
    // p.join spells the host separator; compare through the same path
    // builder instead of hardcoding POSIX slashes.
    final sep = Platform.pathSeparator;
    expect(
      KeymapStore.defaultPath(environment: {'HOME': '/users/dev'}),
      '/users/dev${sep}.config${sep}harness${sep}keybindings.jsonc',
    );
    expect(
      KeymapStore.defaultPath(
        environment: {'HOME': '/users/dev', 'XDG_CONFIG_HOME': '/dotfiles'},
      ),
      '/dotfiles${sep}harness${sep}keybindings.jsonc',
    );
    expect(
      KeymapStore.defaultPath(
        environment: {'HOME': '/users/dev', 'XDG_CONFIG_HOME': 'relative'},
      ),
      '/users/dev${sep}.config${sep}harness${sep}keybindings.jsonc',
    );
  });
}
