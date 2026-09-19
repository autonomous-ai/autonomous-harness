import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/wsl_runtime.dart';

/// Lives argv against a real WSL distro, when one exists.
///
/// The unit suite injects fake process hooks, so it can never see what
/// `wsl.exe` does to the command line it is handed — and `--` handing the
/// remainder to the distro's default shell for a second parse round silently
/// stripped every argument the app sent (the CLI answered the help banner with
/// exit 0). This file runs the ACTUAL shape `buildArguments` produces against
/// an actual distro and asserts the arguments arrive; it no-ops where WSL or a
/// usable distro is missing rather than failing hosts that cannot run it.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('buildArguments delivers argv to the distro shell intact', () async {
    final runtime = WslRuntime();
    if (!Platform.isWindows) {
      // buildArguments is only ever executed on the Windows host.
      return;
    }
    if (!await runtime.available()) {
      return; // no WSL on this machine: nothing this test can prove here
    }
    final distros = await runtime.usableDistros();
    if (distros.isEmpty) {
      return; // Docker-only machines are excluded by design
    }
    final distro = distros.first;

    final marker = runtime.buildArguments(
      distro: distro,
      script: r'echo "count=$#; zero=$0; one=$1; two=$2"',
      scriptName: 'probe-name',
      scriptArguments: ['first arg', 'second arg'],
    );

    final result = await Process.run(WslRuntime.executable, marker);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    expect(
      '${result.stdout}'.trim(),
      contains('count=2; zero=probe-name; one=first arg; two=second arg'),
      reason:
          'wsl must deliver the -c script and its \$0-trailing arguments '
          'verbatim; a second shell parse round strips them',
    );
  }, timeout: const Timeout(Duration(minutes: 2)));
}
