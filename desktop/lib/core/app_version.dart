import 'dart:io';

import 'package:package_info_plus/package_info_plus.dart';

/// The version of the build currently running.
///
/// `flutter build linux` has no equivalent of Xcode's Info.plist stamping —
/// there is nowhere inside a Linux build for the release version to live, so
/// [PackageInfo.fromPlatform] would just return `pubspec.yaml`'s placeholder
/// (`1.0.0+1`, deliberately never bumped — see RELEASE.md). The Linux release
/// script (`scripts/upload-desktop-linux.sh`) instead writes a plain
/// `version.txt` next to the built executable; this reads that back when it
/// exists and falls through to [PackageInfo] everywhere else — macOS,
/// Windows, or a Linux dev build with no packaged `version.txt`.
Future<String> runningAppVersion({
  String? executablePath,
  Future<String> Function()? packageInfoVersion,
}) async {
  if (Platform.isLinux) {
    final exe = File(executablePath ?? Platform.resolvedExecutable);
    final versionFile = File('${exe.parent.path}/version.txt');
    try {
      // Read synchronously. It is a dozen bytes sitting next to the executable,
      // and an async read of it never completes inside flutter_test's
      // fake-async zone: every widget test on a Linux host would sit forever on
      // this line and paint the em dash the FutureBuilder falls back to, while
      // the same widget showed a version on macOS (which skips this branch).
      final raw = versionFile.readAsStringSync().trim();
      if (raw.isNotEmpty) return raw;
    } catch (_) {
      // Not a packaged build (no version.txt) — fall through below.
    }
  }
  return packageInfoVersion != null
      ? packageInfoVersion()
      : (await PackageInfo.fromPlatform()).version;
}
