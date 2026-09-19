import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_git_projects.dart';

/// Compares paths the way the host spells them: the library joins with
/// `p.join` (host separators) while these fixtures spell forward slashes,
/// and on Windows the two differ for the same file.
bool _samePath(String a, String b) =>
    a.replaceAll(r'\', '/') == b.replaceAll(r'\', '/');

Future<void> _metadata(
  String path,
  String branch, {
  String remote = 'repo',
}) async {
  await Directory(path).create(recursive: true);
  await File('$path/HEAD').writeAsString('ref: refs/heads/$branch\n');
  await File('$path/config').writeAsString(
    '[remote "origin"]\n url = git@github.com:team/$remote.git\n',
  );
}

class _Watches {
  final streams = <String, List<StreamController<FileSystemEvent>>>{};

  /// The watcher registers directories with `p.normalize`, whose separator
  /// follows the host; key the fake the same way so lookups match on Windows
  /// (where the fixtures' forward slashes and the platform's backslashes mix).
  static String _key(String path) => path.replaceAll(r'\', '/');

  Stream<FileSystemEvent> watch(String path, int events, bool recursive) {
    expect(recursive, isFalse);
    final controller = StreamController<FileSystemEvent>();
    (streams[_key(path)] ??= []).add(controller);
    return controller.stream;
  }

  void change(String directory, String path) {
    emit(directory, FileSystemModifyEvent(path, false, true));
  }

  void emit(String directory, FileSystemEvent event) {
    for (final stream in streams[_key(directory)] ?? []) {
      if (stream.hasListener) stream.add(event);
    }
  }

  List<StreamController<FileSystemEvent>>? at(String path) =>
      streams[_key(path)];

  Future<void> dispose() async {
    for (final stream in streams.values.expand((streams) => streams)) {
      await stream.close();
    }
  }
}

class _HeldFile implements File {
  _HeldFile(this.file, this.started, this.release);
  final File file;
  final Completer<void> started;
  final Future<void> release;
  @override
  Future<RandomAccessFile> open({FileMode mode = FileMode.read}) async =>
      _HeldHandle(await file.open(mode: mode), started, release);
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _HeldHandle implements RandomAccessFile {
  _HeldHandle(this.file, this.started, this.release);
  final RandomAccessFile file;
  final Completer<void> started;
  final Future<void> release;
  @override
  Future<Uint8List> read(int bytes) async {
    final result = await file.read(bytes);
    started.complete();
    await release;
    return result;
  }

  @override
  Future<void> close() => file.close();
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  test(
    'a changed worktree pointer follows the new metadata directory',
    () async {
      final fixture = await Directory.systemTemp.createTemp(
        'harness-git-move-',
      );
      final root = '${fixture.path}/work';
      await Directory(root).create();
      final oldMetadata = '${fixture.path}/before';
      final newMetadata = '${fixture.path}/after';
      await _metadata(oldMetadata, 'before');
      await _metadata(newMetadata, 'after', remote: 'new-project');
      final pointer = File('$root/.git');
      await pointer.writeAsString('gitdir: $oldMetadata\n');
      final watches = _Watches();
      final changes = StreamController<void>.broadcast();
      final reader = LocalGitProjects(onChanged: () => changes.add(null));
      addTearDown(() async {
        reader.dispose();
        await watches.dispose();
        await changes.close();
        await fixture.delete(recursive: true);
      });
      await IOOverrides.runZoned(() async {
        await reader.read(root);
        expect(reader.cached(root)!.branch, 'before');
        final changed = changes.stream.firstWhere(
          (_) => reader.cached(root)?.branch == 'after',
        );
        await pointer.writeAsString('gitdir: $newMetadata\n');
        watches.change(root, pointer.path);
        await changed.timeout(const Duration(seconds: 3));
        expect(reader.cached(root)!.remote, 'github.com/team/new-project');
        expect(watches.at(oldMetadata)!.single.hasListener, isFalse);
        final next = changes.stream.firstWhere(
          (_) => reader.cached(root)?.branch == 'next',
        );
        await File('$newMetadata/HEAD').writeAsString('ref: refs/heads/next\n');
        watches.change(newMetadata, '$newMetadata/HEAD');
        await next.timeout(const Duration(seconds: 3));

        final shared = '${fixture.path}/shared';
        await _metadata(shared, 'unrelated-main', remote: 'shared-project');
        final commonChanged = changes.stream.firstWhere(
          (_) =>
              reader.cached(root)?.remote == 'github.com/team/shared-project',
        );
        await File('$newMetadata/commondir').writeAsString('../shared\n');
        watches.change(newMetadata, '$newMetadata/commondir');
        await commonChanged.timeout(const Duration(seconds: 3));
        expect(reader.cached(root)!.branch, 'next');
        final remoteChanged = changes.stream.firstWhere(
          (_) => reader.cached(root)?.remote == 'github.com/team/renamed',
        );
        await File('$shared/config').writeAsString(
          '[remote "origin"]\n url = https://github.com/team/renamed.git\n',
        );
        watches.change(shared, '$shared/config');
        await remoteChanged.timeout(const Duration(seconds: 3));
      }, fsWatch: watches.watch);
    },
  );

  for (final failure in ['done', 'error']) {
    test(
      'a watcher $failure refreshes stale metadata without retrying forever',
      () async {
        final fixture = await Directory.systemTemp.createTemp(
          'harness-git-watch-',
        );
        final root = fixture.path;
        final metadata = '$root/.git';
        await _metadata(metadata, 'before');
        final watches = _Watches();
        final changes = StreamController<void>.broadcast();
        var now = DateTime(2026, 9, 13);
        final reader = LocalGitProjects(
          onChanged: () => changes.add(null),
          now: () => now,
        );
        addTearDown(() async {
          reader.dispose();
          await watches.dispose();
          await changes.close();
          await fixture.delete(recursive: true);
        });
        await IOOverrides.runZoned(() async {
          await reader.read(root);
          final changed = changes.stream.firstWhere(
            (_) => reader.cached(root)?.branch == 'after',
          );
          await File('$metadata/HEAD').writeAsString('ref: refs/heads/after\n');
          final stream = watches.at(metadata)!.single;
          if (failure == 'done') {
            await stream.close();
          } else {
            stream.addError(const FileSystemException('watch stopped'));
          }
          await changed.timeout(const Duration(seconds: 3));
          expect(reader.cached(root)!.branch, 'after');
          expect(watches.at(metadata), hasLength(1));
          await reader.read(root);
          now = now.add(const Duration(minutes: 1));
          await reader.read(root);
          expect(watches.at(metadata), hasLength(2));
          final recovered = changes.stream.firstWhere(
            (_) => reader.cached(root)?.branch == 'recovered',
          );
          await File('$metadata/HEAD')
              .writeAsString('ref: refs/heads/recovered\n');
          watches.change(metadata, '$metadata/HEAD');
          await recovered.timeout(const Duration(seconds: 3));
        }, fsWatch: watches.watch);
      },
    );
  }

  test('unsupported watches preserve metadata and retry only after discovery expires', () async {
    final fixture = await Directory.systemTemp.createTemp(
      'harness-git-unwatched-',
    );
    final metadata = '${fixture.path}/.git';
    await _metadata(metadata, 'before');
    var attempts = 0;
    var now = DateTime(2026, 9, 13);
    final reader = LocalGitProjects(onChanged: () {}, now: () => now);
    addTearDown(() async {
      reader.dispose();
      await fixture.delete(recursive: true);
    });
    await IOOverrides.runZoned(
      () async {
        await reader.read(fixture.path);
        expect(reader.cached(fixture.path)!.branch, 'before');
        final firstAttempts = attempts;
        expect(firstAttempts, greaterThan(0));
        await File('$metadata/HEAD').writeAsString('ref: refs/heads/after\n');
        await reader.read(fixture.path);
        expect(attempts, firstAttempts);
        now = now.add(const Duration(minutes: 1));
        await reader.read(fixture.path);
        expect(reader.cached(fixture.path)!.branch, 'after');
        expect(attempts, firstAttempts * 2);
      },
      fsWatch: (_, _, _) {
        attempts++;
        throw UnsupportedError('No filesystem watcher');
      },
    );
  });

  test(
    'discovery expires a silent watch and clears a removed working folder',
    () async {
      final fixture = await Directory.systemTemp.createTemp(
        'harness-git-cache-',
      );
      final metadata = '${fixture.path}/.git';
      final cwd = Directory('${fixture.path}/src');
      await _metadata(metadata, 'before');
      await cwd.create();
      final watches = _Watches();
      var now = DateTime(2026, 9, 13);
      var changes = 0;
      final reader = LocalGitProjects(
        onChanged: () => changes++,
        now: () => now,
      );
      addTearDown(() async {
        reader.dispose();
        await watches.dispose();
        await fixture.delete(recursive: true);
      });
      await IOOverrides.runZoned(() async {
        await reader.read(cwd.path);
        final first = reader.cached(cwd.path)!;
        await File('$metadata/HEAD').writeAsString('ref: refs/heads/after\n');
        await reader.read(cwd.path);
        expect(reader.cached(cwd.path), same(first));
        now = now.add(const Duration(minutes: 1));
        await reader.read(cwd.path);
        expect(reader.cached(cwd.path)!.branch, 'after');
        await cwd.delete();
        now = now.add(const Duration(minutes: 1));
        await reader.read(cwd.path);
        expect(reader.cached(cwd.path), isNull);
        expect(
          watches.streams.values.expand((s) => s).any((s) => s.hasListener),
          isFalse,
        );
        await cwd.create();
        now = now.add(const Duration(minutes: 1));
        await reader.read(cwd.path);
        expect(reader.cached(cwd.path)!.branch, 'after');
        expect(changes, 4);
      }, fsWatch: watches.watch);
    },
  );

  test('replacing a Git directory rebinds watches at the same path', () async {
    final fixture = await Directory.systemTemp.createTemp(
      'harness-git-replace-',
    );
    final root = '${fixture.path}/repo';
    final metadata = '$root/.git';
    await _metadata(metadata, 'before');
    final watches = _Watches();
    final changes = StreamController<void>.broadcast();
    final reader = LocalGitProjects(onChanged: () => changes.add(null));
    addTearDown(() async {
      reader.dispose();
      await watches.dispose();
      await changes.close();
      await fixture.delete(recursive: true);
    });
    await IOOverrides.runZoned(() async {
      await reader.read(root);
      final changed = changes.stream.firstWhere(
        (_) => reader.cached(root)?.branch == 'replacement',
      );
      final moved = await Directory(metadata).rename('${fixture.path}/old');
      await _metadata(metadata, 'replacement');
      watches.emit(root, FileSystemMoveEvent(metadata, true, moved.path));
      await changed.timeout(const Duration(seconds: 3));
      expect(watches.at(metadata), hasLength(2));
      expect(watches.at(metadata)!.first.hasListener, isFalse);
      expect(watches.at(metadata)!.last.hasListener, isTrue);
      final next = changes.stream.firstWhere(
        (_) => reader.cached(root)?.branch == 'next',
      );
      await File('$metadata/HEAD').writeAsString('ref: refs/heads/next\n');
      watches.change(metadata, '$metadata/HEAD');
      await next.timeout(const Duration(seconds: 3));
    }, fsWatch: watches.watch);
  });

  for (final disposeWhileReading in [false, true]) {
    test(
      'a delayed read serializes invalidation (dispose=$disposeWhileReading)',
      () async {
        final fixture = await Directory.systemTemp.createTemp(
          'harness-git-pending-',
        );
        final root = fixture.path;
        final metadata = '$root/.git';
        final head = File('$metadata/HEAD');
        await _metadata(metadata, 'before');
        final watches = _Watches();
        final reader = LocalGitProjects(onChanged: () {});
        final started = Completer<void>();
        final release = Completer<void>();
        var hold = false;
        var headReads = 0;
        final outside = Zone.current;
        addTearDown(() async {
          if (!release.isCompleted) release.complete();
          reader.dispose();
          await watches.dispose();
          await fixture.delete(recursive: true);
        });
        await IOOverrides.runZoned(
          () async {
            await reader.read(root);
            hold = true;
            await head.writeAsString('ref: refs/heads/intermediate\n');
            watches.change(metadata, head.path);
            await started.future.timeout(const Duration(seconds: 3));
            final pending = reader.read(root);
            expect(reader.read(root), same(pending));
            await head.writeAsString('ref: refs/heads/latest\n');
            watches.change(metadata, head.path);
            await Future<void>.delayed(const Duration(milliseconds: 180));
            expect(headReads, 2);
            if (disposeWhileReading) reader.dispose();
            release.complete();
            await pending;
            expect(
              reader.cached(root)?.branch,
              disposeWhileReading ? null : 'latest',
            );
            if (disposeWhileReading) {
              expect(
                watches.streams.values
                    .expand((s) => s)
                    .any((s) => s.hasListener),
                isFalse,
              );
            } else {
              expect(headReads, 3);
            }
          },
          fsWatch: watches.watch,
          createFile: (path) {
            if (_samePath(path, head.path)) {
              headReads++;
              if (hold) {
                hold = false;
                return _HeldFile(head, started, release.future);
              }
            }
            return outside.run(() => File(path));
          },
        );
      },
    );
  }

  test('local Git metadata shares repository identity and watches worktree branches', () async {
    final fixture = await Directory.systemTemp.createTemp(
      'harness-git-context-',
    );
    final root = fixture.path;
    final main = Directory('$root/repo/.git');
    await main.create(recursive: true);
    await File(
      '${main.path}/config',
    ).writeAsString('[remote "origin"]\n url = git@github.com:Team/Repo.git\n');
    await File('${main.path}/HEAD').writeAsString('ref: refs/heads/main\n');
    await Directory('$root/repo/src').create();
    final tree = Directory('$root/feature');
    await tree.create();
    final meta = Directory('${main.path}/worktrees/feature');
    await meta.create(recursive: true);
    await File('${tree.path}/.git').writeAsString('gitdir: ${meta.path}\n');
    await File('${meta.path}/commondir').writeAsString('../..\n');
    await File('${meta.path}/HEAD')
        .writeAsString('ref: refs/heads/feature/login\n');
    final changed = Completer<void>();
    late LocalGitProjects reader;
    reader = LocalGitProjects(
      onChanged: () {
        if (reader.cached(tree.path)?.branch == 'feature/fix' &&
            !changed.isCompleted) {
          changed.complete();
        }
      },
    );
    addTearDown(() async {
      reader.dispose();
      await fixture.delete(recursive: true);
    });
    await Future.wait([reader.read('$root/repo/src'), reader.read(tree.path)]);
    final project = reader.cached('$root/repo/src')!;
    // The library publishes the root with host separators (p.join); the
    // fixture spells POSIX, so compare in one spelling.
    expect(_samePath(project.root!, '$root/repo'), isTrue);
    expect(project.branch, 'main');
    expect(project.remote, 'github.com/team/repo');
    expect(reader.cached(tree.path)!.remote, project.remote);
    expect(reader.cached(tree.path)!.branch, 'feature/login');
    await reader.read(tree.path);
    expect(reader.cached('$root/repo/src'), same(project));
    await File('${meta.path}/HEAD')
        .writeAsString('ref: refs/heads/feature/fix\n');
    await changed.future.timeout(const Duration(seconds: 4));
    expect(reader.cached(tree.path)!.branch, 'feature/fix');
    expect(reader.cached('$root/repo/src'), same(project));
  });

  test(
    'remote identity removes credentials and respects host and port semantics',
    () {
      expect(
        canonicalGitRemote('https://user:secret@GitHub.com/TEAM/Repo.git'),
        'github.com/team/repo',
      );
      expect(
        canonicalGitRemote('ssh://git@example.org:2222/Team/Repo.git'),
        'example.org:2222/Team/Repo',
      );
      expect(
        canonicalGitRemote('git@example.org:Team/Repo.git'),
        'example.org/Team/Repo',
      );
      expect(canonicalGitRemote('file:///private/repo'), isNull);
    },
  );
}
