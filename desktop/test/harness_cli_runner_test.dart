import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/core/wsl_runtime.dart';

void main() {
  late Directory scratch;

  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('harness-cli-runner-');
  });

  tearDown(() async {
    if (await scratch.exists()) await scratch.delete(recursive: true);
  });

  test(
    'uses the managed Node runtime and CLI bundle without a shell',
    () async {
      final home = Directory('${scratch.path}/home')..createSync();
      final harnessHome = Directory('${home.path}/.harness')..createSync();
      final node = File('${harnessHome.path}/runtime/node-v22/bin/node')
        ..createSync(recursive: true);
      File('${harnessHome.path}/runtime/current-node')
        ..createSync(recursive: true)
        ..writeAsStringSync('${node.path}\n');
      final cli = File('${harnessHome.path}/cli/cli.js')
        ..createSync(recursive: true);

      final invocation = await HarnessCliRunner(
        harnessHome: harnessHome,
        environment: {'HOME': home.path, 'PATH': '/usr/bin'},
        isWindows: false,
      ).resolve(['link', 'create']);

      expect(invocation.source, HarnessCliSource.managed);
      expect(invocation.executable, node.path);
      expect(invocation.arguments, [cli.path, 'link', 'create']);
      expect(invocation.executable, isNot(contains('zsh')));
      expect(
        invocation.environment['PATH'],
        '${home.path}/.local/bin:/usr/bin',
      );
      if (Platform.isMacOS || Platform.isLinux) {
        expect(invocation.environment['LC_ALL'], 'C.UTF-8');
      }
    },
    // Windows builds every file path with its own separator; these
    // expectations spell POSIX absolute paths and are the managed-tier
    // contract as macOS and Linux ship it.
    skip: Platform.isWindows ? 'POSIX path expectations' : false,
  );

  test('preserves a UTF-8 locale supplied by the user', () async {
    final home = Directory('${scratch.path}/home')..createSync();
    final harnessHome = Directory('${home.path}/.harness')..createSync();
    final invocation = await HarnessCliRunner(
      harnessHome: harnessHome,
      isWindows: false,
      environment: {
        'HOME': home.path,
        'PATH': '/usr/bin',
        'LANG': 'vi_VN.UTF-8',
      },
    ).resolve(['start']);

    expect(invocation.environment['LANG'], 'vi_VN.UTF-8');
    expect(invocation.environment['LC_ALL'], isNull);
  });

  test('uses the explicit legacy launcher before PATH', () async {
    final home = Directory('${scratch.path}/home')..createSync();
    final harnessHome = Directory('${home.path}/.harness')..createSync();
    final launcher = File('${home.path}/.local/bin/harness')
      ..createSync(recursive: true);
    assert(launcher.path.isNotEmpty);

    final invocation = await HarnessCliRunner(
      harnessHome: harnessHome,
      environment: {'HOME': home.path, 'PATH': '/usr/bin'},
      isWindows: false,
    ).resolve(['start']);

    expect(invocation.source, HarnessCliSource.launcher);
    // The runner builds the launcher path from the home it was given, whose
    // separators follow the platform; compare separator-insensitively.
    expect(
      invocation.executable.replaceAll(r'\', '/'),
      '${home.path.replaceAll(r'\', '/')}/.local/bin/harness',
    );
    expect(invocation.arguments, ['start']);
  });

  test('a command that never finishes is an error within the bound, not a wait without end', () async {
    // A `harness start` that had to reach a black-holed backend hung here, and the app — waiting on
    // it to say "Starting local service…" was over — hung with it, for good.
    final home = Directory('${scratch.path}/home')..createSync();
    final harnessHome = Directory('${home.path}/.harness')..createSync();
    final runner = HarnessCliRunner(
      harnessHome: harnessHome,
      environment: {'HOME': home.path, 'PATH': '/usr/bin'},
      runTimeout: const Duration(milliseconds: 50),
      runProcess: (command, argv, {environment}) =>
          Completer<ProcessResult>().future,
    );

    await expectLater(
      runner.run(['start']),
      throwsA(
        isA<ProcessException>().having(
          (e) => e.message,
          'message',
          contains('did not finish'),
        ),
      ),
    );
  });

  test('remote-password status invokes cli.js as direct argv and reads its JSON result', () async {
    final home = Directory('${scratch.path}/home')..createSync();
    final harnessHome = Directory('${home.path}/.harness')..createSync();
    final node = File('${harnessHome.path}/runtime/node-v22/bin/node')
      ..createSync(recursive: true);
    File('${harnessHome.path}/runtime/current-node')
      ..createSync(recursive: true)
      ..writeAsStringSync('${node.path}\n');
    final cli = File('${harnessHome.path}/cli/cli.js')
      ..createSync(recursive: true);
    assert(cli.path.isNotEmpty);
    String? executable;
    List<String>? arguments;

    final result = await CliLink(
      runner: HarnessCliRunner(
        harnessHome: harnessHome,
        environment: {'HOME': home.path, 'PATH': '/usr/bin'},
        isWindows: false,
        runProcess: (command, argv, {environment}) async {
          executable = command;
          arguments = argv;
          return ProcessResult(
            42,
            0,
            '{"hasPassword":true,"fingerprint":"1234ABCD",'
                '"setAt":1700000000000}\n',
            '',
          );
        },
      ),
    ).remotePasswordStatus();

    expect(executable, node.path);
    // argv[0] is built from the given home plus host separators, which on a
    // Windows host can mix; the path is the same file either way.
    String asPosix(String p) => p.replaceAll(r'\', '/');
    expect(
      arguments!.map(asPosix),
      [
        '${asPosix(home.path)}/.harness/cli/cli.js',
        'remote-password',
        'status',
        '--json',
      ],
    );
    expect(result.error, isNull);
    expect(result.hasPassword, isTrue);
    expect(result.fingerprint, '1234ABCD');
    expect(result.setAt, DateTime.fromMillisecondsSinceEpoch(1700000000000));
    // Exercises the managed-tier resolution on a home whose path mixes the
    // platform separators — the shape Windows hands every File() call.
  });

  test('packaged Windows runner uses bundled CLI in WSL with Linux update controls', () async {
    final bundle = Directory('${scratch.path}/Release Folder/harness-cli')
      ..createSync(recursive: true);
    File('${bundle.path}/cli.js').writeAsStringSync('cli');
    File('${bundle.path}/notify.mjs').writeAsStringSync('notify');
    final runtime = WslRuntime(
      runProcess: (executable, arguments, {environment}) async {
        final joined = arguments.join(' ');
        if (joined.contains('--status')) return ProcessResult(0, 0, 'ok', '');
        if (joined.contains('-l -q')) {
          return ProcessResult(0, 0, 'Ubuntu\r\n', '');
        }
        return ProcessResult(0, 0, 'cli launcher\ntmux yes\n', '');
      },
    );

    final invocation = await HarnessCliRunner(
      harnessHome: Directory('${scratch.path}/host-home/.harness'),
      environment: {
        'USERPROFILE': '${scratch.path}/host-home',
        'PATH': '',
      },
      isWindows: true,
      requiresWindowsBundle: true,
      windowsBundleDirectory: bundle,
      wslRuntime: runtime,
    ).resolve(['auth', 'status', '--json', 'value with "quotes"']);

    expect(invocation.source, HarnessCliSource.wsl);
    expect(invocation.wslDistro, 'Ubuntu');
    expect(invocation.arguments, contains(bundle.path));
    expect(
      invocation.arguments,
      containsAllInOrder(['auth', 'status', '--json', 'value with "quotes"']),
    );
    final script = invocation.arguments[5];
    expect(script, contains(r'wslpath -u -- "$1"'));
    expect(script, contains('export ADAPTER_UPDATE_DISABLE=true'));
    expect(script, contains(r'export ADAPTER_CLI_DIR="$bundle_dir"'));
    expect(script, contains(r'exec "$node" "$bundle_dir/cli.js" "$@"'));
    expect(invocation.environment['ADAPTER_UPDATE_DISABLE'], isNull);

  });

  test(
    'packaged Windows runner fails clearly for an incomplete bundle',
    () async {
      final bundle = Directory('${scratch.path}/harness-cli')..createSync();
      File('${bundle.path}/cli.js').writeAsStringSync('cli');

      final runner = HarnessCliRunner(
        harnessHome: Directory('${scratch.path}/host-home/.harness'),
        environment: {'USERPROFILE': '${scratch.path}/host-home', 'PATH': ''},
        isWindows: true,
        requiresWindowsBundle: true,
        windowsBundleDirectory: bundle,
        wslRuntime: WslRuntime(
          runProcess: (executable, arguments, {environment}) async =>
              ProcessResult(0, 1, '', ''),
        ),
      );

      await expectLater(
        runner.resolve(['version']),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'message',
            contains('notify.mjs'),
          ),
        ),
      );
    },
  );

  test(
    'unmarked Windows development runner preserves installed WSL CLI behavior',
    () async {
      final runtime = WslRuntime(
        runProcess: (executable, arguments, {environment}) async {
          final joined = arguments.join(' ');
          if (joined.contains('--status')) return ProcessResult(0, 0, 'ok', '');
          if (joined.contains('-l -q')) {
            return ProcessResult(0, 0, 'Ubuntu\r\n', '');
          }
          return ProcessResult(0, 0, 'cli launcher\ntmux yes\n', '');
        },
      );
      final invocation = await HarnessCliRunner(
        harnessHome: Directory('${scratch.path}/host-home/.harness'),
        environment: {'USERPROFILE': '${scratch.path}/host-home', 'PATH': ''},
        isWindows: true,
        requiresWindowsBundle: false,
        windowsBundleDirectory: Directory('${scratch.path}/missing-bundle'),
        wslRuntime: runtime,
      ).resolve(['version']);

      expect(
        invocation.arguments[5],
        contains(r'exec "$HOME/.local/bin/harness"'),
      );
      expect(
        invocation.arguments,
        isNot(contains('${scratch.path}/missing-bundle')),
      );
    },
  );
}
