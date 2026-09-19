import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/app_version.dart';

void main() {
  test(
    'packaged preview displays its full version and falls back when absent',
    () async {
      final scratch = await Directory.systemTemp.createTemp('harness-version-');
      addTearDown(() => scratch.delete(recursive: true));
      final executable = '${scratch.path}/harness.exe';
      expect(
        await runningAppVersion(
          executablePath: executable,
          packageInfoVersion: () async => '1.0.0',
        ),
        '1.0.0',
      );
      await File('${scratch.path}/version.txt')
          .writeAsString('1.0.0-windows.1\n');
      expect(
        await runningAppVersion(
          executablePath: executable,
          packageInfoVersion: () async => '1.0.0',
        ),
        '1.0.0-windows.1',
      );
    },
    skip: !(Platform.isLinux || Platform.isWindows),
  );
}
