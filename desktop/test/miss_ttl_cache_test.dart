import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/backend_path.dart';

void main() {
  test('overlapping callers share one successful source read', () async {
    final source = Completer<String?>();
    var reads = 0;
    final cache = MissTtlCache<String>(ttl: const Duration(seconds: 5));

    Future<String?> readSource() {
      reads++;
      return source.future;
    }

    final first = cache.read(readSource);
    final second = cache.read(readSource);
    expect(reads, 1);

    source.complete('Ubuntu');
    expect(await Future.wait([first, second]), ['Ubuntu', 'Ubuntu']);
    expect(await cache.read(readSource), 'Ubuntu');
    expect(reads, 1);
  });

  test('a completed miss starts the TTL and is shared by overlapping callers', () async {
    var now = DateTime.utc(2026, 9, 19, 12);
    final firstSource = Completer<String?>();
    var reads = 0;
    final cache = MissTtlCache<String>(
      ttl: const Duration(seconds: 5),
      now: () => now,
    );

    Future<String?> readSource() {
      reads++;
      return reads == 1 ? firstSource.future : Future.value('ready');
    }

    final first = cache.read(readSource);
    final second = cache.read(readSource);
    now = now.add(const Duration(minutes: 1));
    firstSource.complete(null);
    expect(await Future.wait([first, second]), [null, null]);
    expect(reads, 1);

    now = now.add(const Duration(seconds: 4));
    expect(await cache.read(readSource), isNull);
    expect(reads, 1);

    now = now.add(const Duration(seconds: 1));
    expect(await cache.read(readSource), 'ready');
    expect(reads, 2);
  });

  test('an overlapping failed read clears in-flight state for an immediate retry', () async {
    final firstSource = Completer<String?>();
    var reads = 0;
    final cache = MissTtlCache<String>(ttl: const Duration(seconds: 5));

    Future<String?> readSource() {
      reads++;
      return reads == 1 ? firstSource.future : Future.value('recovered');
    }

    final first = cache.read(readSource);
    final second = cache.read(readSource);
    expect(reads, 1);

    final firstFailure = expectLater(first, throwsStateError);
    final secondFailure = expectLater(second, throwsStateError);
    firstSource.completeError(StateError('probe failed'));
    await Future.wait([firstFailure, secondFailure]);

    expect(await cache.read(readSource), 'recovered');
    expect(reads, 2);
  });

  test('a synchronous source exception also permits an immediate retry', () async {
    var reads = 0;
    final cache = MissTtlCache<String>(ttl: const Duration(seconds: 5));

    Future<String?> readSource() {
      reads++;
      if (reads == 1) throw StateError('synchronous probe failure');
      return Future.value('recovered');
    }

    await expectLater(cache.read(readSource), throwsStateError);
    expect(await cache.read(readSource), 'recovered');
    expect(reads, 2);
  });
}
