import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_cli_runner.dart';

/// RESULT tests, not expected-argv lists.
///
/// Two claims are on trial, and each is decided by reading what a real child
/// received:
///
/// 1. A native executable spawned with no shell receives argv verbatim — spaces,
///    embedded double quotes, Unicode and shell metacharacters.
/// 2. Routing the same argv through `cmd.exe /d /c` does not — which is why the
///    WSL-only production runner never forwards a `.cmd`/`.bat` shim. The
///    refusal is asserted here too: nothing claims a shim's arguments are safe.
void main() {
  /// Arguments no shell may touch. `&` is cmd's command separator, `^` its
  /// escape, `|` a pipe, `%` a variable marker.
  const hostile = <String>[
    '--name=R&D',
    '--name=R and D',
    '--json={"name":"x","nested":"a & b"}',
    '--name=Ünïcødé 日本',
    '--name=100%done',
    '--name=a^b',
    '--name=a|b',
    '--path=C:\\Program Files\\Harness',
    '--path=C:\\trailing\\',
  ];

  Future<Directory> freshDir(String label) => Directory(
    '${Directory.current.path}\\.toolchain\\state\\argvfixture-$label-'
    '${DateTime.now().microsecondsSinceEpoch}',
  ).create(recursive: true);

  /// A real Windows `node.exe`, used as the native receiver.
  Future<({String? path, String reason})> nodeImage() async {
    try {
      final where = await Process.run('where', ['node.exe']);
      if (where.exitCode != 0) {
        return (path: null, reason: 'node.exe is not on PATH for this host');
      }
      final path = '${where.stdout}'
          .split('\n')
          .map((line) => line.trim())
          .firstWhere((line) => line.isNotEmpty, orElse: () => '');
      return path.isEmpty
          ? (path: null, reason: 'where node.exe printed nothing')
          : (path: path, reason: '');
    } on ProcessException catch (error) {
      return (path: null, reason: 'node.exe could not be started: $error');
    }
  }

  test('a native executable receives hostile argv verbatim', () async {
    if (!Platform.isWindows) {
      markTestSkipped('Windows-only fixture');
      return;
    }
    final node = await nodeImage();
    if (node.path == null) {
      // An explicit, REPORTED skip — never a pass that ran nothing.
      markTestSkipped(node.reason);
      return;
    }

    final directory = await freshDir('native');
    final script = File('${directory.path}\\argv.js');
    await script.writeAsString(
      'const fs=require("fs");'
      'fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));',
    );
    final out = File('${directory.path}\\argv.json');

    final result = await Process.run(node.path!, [
      script.path,
      out.path,
      ...hostile,
    ]);

    expect(result.exitCode, 0, reason: '${result.stderr}');
    expect(jsonDecode(out.readAsStringSync()), hostile);
  });

  test('cmd.exe /d /c corrupts the same argv — and shims are refused', () async {
    if (!Platform.isWindows) {
      markTestSkipped('Windows-only fixture');
      return;
    }
    final directory = await freshDir('cmd');
    final shim = File('${directory.path}\\argdump.cmd');
    final out = File('${directory.path}\\args.txt');
    // Every receiver line APPENDS: three `>` redirected to the same file would
    // leave one line behind and silently discard the arguments a negative
    // assertion is about — the defect in this instrument before.
    await shim.writeAsString(
      '@echo off\r\n'
      '> "${out.path}" echo RAW=[%*]\r\n'
      '>> "${out.path}" echo ARG1=[%~1]\r\n'
      '>> "${out.path}" echo ARG2=[%~2]\r\n',
    );

    Future<Map<String, String>> throughCmd(List<String> args) async {
      if (out.existsSync()) out.deleteSync();
      await Process.run('cmd.exe', ['/d', '/c', shim.path, ...args]);
      final lines = out.existsSync()
          ? utf8
                .decode(out.readAsBytesSync(), allowMalformed: true)
                .trim()
                .split(RegExp(r'\r?\n'))
          : <String>[];
      final values = <String, String>{};
      for (final line in lines) {
        final index = line.indexOf('=');
        if (index <= 0) continue;
        values[line.substring(0, index)] = line.substring(index + 1);
      }
      return values;
    }

    // The exact received values, all three lines present.
    final ampersand = await throughCmd(['link', 'create', '--name=R&D']);
    expect(ampersand.length, 3, reason: 'all three receivers must record');
    expect(ampersand['RAW'], isNot('[link create --name=R&D]'));
    expect(ampersand['ARG2'], isNot('R&D'));

    // Raw recorded text, so a parser quirk in the instrument cannot mask the
    // argument itself. `%~1` stripping quotes is exactly why the value is read
    // from the file rather than reconstructed.
    Future<String> throughCmdText(List<String> args) async {
      if (out.existsSync()) out.deleteSync();
      await Process.run('cmd.exe', ['/d', '/c', shim.path, ...args]);
      return out.existsSync()
          ? utf8.decode(out.readAsBytesSync(), allowMalformed: true).trim()
          : '';
    }

    expect(
      await throughCmdText(['--name=a^b']),
      isNot(contains('--name=a^b')),
      reason: 'cmd eats the caret',
    );
    expect(
      await throughCmdText(['--name=Ünïcødé 日本']),
      isNot(contains('--name=Ünïcødé 日本')),
      reason: 'a non-ASCII argument is not carried through cmd',
    );
    // A space-bearing argument survives only because Dart quotes it.
    expect(
      await throughCmdText(['--name=R and D']),
      contains('--name=R and D'),
    );

    // The production runner ignores every host-side shim and requires WSL, so
    // no argument is silently reinterpreted on this path.
    final shimOnly = await freshDir('shim-only');
    await File('${shimOnly.path}\\harness.cmd').writeAsString('@echo off\r\n');
    final runner = HarnessCliRunner(
      harnessHome: Directory('${Directory.systemTemp.path}\\harness-shim'),
      environment: {'USERPROFILE': shimOnly.path, 'PATH': shimOnly.path},
      runProcess: (executable, arguments, {environment}) async =>
          ProcessResult(0, 1, '', ''),
    );
    final invocation = await runner.resolve(['--name=R&D']);
    expect(invocation.executable, isNot('cmd.exe'));
    expect(invocation.executable, HarnessCliRunner.windowsMissingCliExecutable);
  });
}
