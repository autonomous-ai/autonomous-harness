import 'dart:async';
import 'dart:ffi';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../core/app_version.dart';

/// Published by `scripts/upload-desktop.sh` (`make upload-desktop`) — see
/// `RELEASE.md` for the full publish-side design this mirrors.
const _defaultMetadataUrl =
    'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/metadata.json';

/// Override for testing against a scratch manifest without touching the real one — see RELEASE.md's
/// "Rolling out safely" section. Empty (the default) means "use the real manifest".
const _metadataUrlOverride = String.fromEnvironment(
  'DESKTOP_UPDATE_METADATA_URL',
);

/// The macOS build every Mac can run, rendered on Skia: what an Intel Mac installs, what every install
/// from before the Intel/Apple Silicon split polls on either CPU, and what the website download
/// serves. Must match the `intel` row of scripts/publish-macos-variant.sh — RELEASE.md, "Two macOS
/// builds", has the why.
const _otaKeyMacOS = 'desktop-macos';

/// The Apple Silicon build, rendered on Impeller. Must match the `apple-silicon` row of
/// scripts/publish-macos-variant.sh.
const _otaKeyMacOSArm64 = 'desktop-macos-arm64';

/// `arm64` or `x64` for the CPU this process runs on: which Linux artifact to fetch, and whether the
/// Apple Silicon macOS build is on offer. An Apple Silicon Mac running this under Rosetta reports x64
/// and is offered only the Skia build — harmless, since both macOS builds are universal.
String _currentArchitecture() => switch (Abi.current()) {
  Abi.linuxArm64 || Abi.macosArm64 || Abi.windowsArm64 => 'arm64',
  Abi.linuxX64 || Abi.macosX64 || Abi.windowsX64 => 'x64',
  _ => throw UnsupportedError(
    'Harness Desktop updates do not support ${Abi.current()}',
  ),
};

String get _metadataUrl => _metadataUrlOverride.isNotEmpty
    ? _metadataUrlOverride
    : _defaultMetadataUrl;

class UpdateInfo {
  final String version;
  final String url;
  final String sha256;
  final int size;

  const UpdateInfo({
    required this.version,
    required this.url,
    required this.sha256,
    required this.size,
  });
}

/// A downloaded, sha256-verified build sitting in a temp directory, not yet swapped into place.
class StagedUpdate {
  final String version;

  /// On macOS: `.../Harness.app` inside [stagingDirPath], unpacked and version-confirmed. On
  /// Linux: the downloaded `.AppImage` file itself (already made executable), directly inside
  /// [stagingDirPath] — there is nothing to unpack.
  final String bundlePath;
  final String stagingDirPath;

  const StagedUpdate({
    required this.version,
    required this.bundlePath,
    required this.stagingDirPath,
  });
}

/// Strict X.Y.Z compare, prerelease/build metadata ignored — same rule as the CLI's own
/// `semverGt` (cli/src/lib/selfUpdate.ts in the harness CLI repo), so publishing an old build can
/// never look newer than what's already running.
bool semverGt(String a, String b) {
  final x = _parseSemverCore(a);
  final y = _parseSemverCore(b);
  if (x == null || y == null) return false;
  for (var i = 0; i < 3; i++) {
    if (x[i] != y[i]) return x[i] > y[i];
  }
  return false;
}

List<int>? _parseSemverCore(String version) {
  final match = RegExp(r'^(\d+)\.(\d+)\.(\d+)').firstMatch(version);
  if (match == null) return null;
  return [
    int.parse(match.group(1)!),
    int.parse(match.group(2)!),
    int.parse(match.group(3)!),
  ];
}

String _singleQuote(String value) => "'${value.replaceAll("'", "'\\''")}'";

/// Resolves the path the running build should be swapped at.
///
/// On macOS this walks up from the running executable to the enclosing
/// `.app` bundle — `.../Harness.app/Contents/MacOS/Harness` -> `.../Harness.app`.
/// On Linux the packaged build is a single `.AppImage` file (see
/// `scripts/upload-desktop-linux.sh`), and a running AppImage executes from a temporary FUSE mount,
/// not from that file — so the file's own path comes from [appImagePath] (tests) or the `APPIMAGE`
/// environment variable the AppImage runtime sets on launch (production), never from
/// `Platform.resolvedExecutable`.
String? currentBundlePath({
  String? executablePath,
  bool? isLinux,
  String? appImagePath,
}) {
  if (isLinux ?? Platform.isLinux) {
    return appImagePath ?? Platform.environment['APPIMAGE'];
  }
  final resolved = executablePath ?? Platform.resolvedExecutable;
  var dir = File(resolved).parent;
  for (var i = 0; i < 6; i++) {
    if (dir.path.endsWith('.app')) return dir.path;
    final parent = dir.parent;
    if (parent.path == dir.path) return null; // reached filesystem root
    dir = parent;
  }
  return null;
}

Future<void> _defaultLaunchDetached(String command) async {
  await Process.start(Platform.isLinux ? '/bin/bash' : '/bin/zsh', [
    '-l',
    '-c',
    command,
  ], mode: ProcessStartMode.detached);
}

/// Checks the public GCS manifest for a newer desktop build than the one currently running,
/// downloads + verifies it, and — once the caller applies it — swaps it into place and relaunches.
/// See `RELEASE.md` for the publish side and the full design (why this doesn't
/// silently auto-restart like the CLI's own self-updater does).
class DesktopUpdater {
  final Dio _dio;
  final Future<void> Function(String command) _launchDetached;
  final String _metadataUrlForInstance;
  final bool _releaseMode;
  final bool _isLinux;
  final String _architecture;

  DesktopUpdater({
    Dio? dio,
    Future<void> Function(String command)? launchDetached,
    // Defaults to the real manifest (or the --dart-define build-time override — see RELEASE.md's
    // "Rolling out safely"). Tests and any other caller that needs a different manifest (e.g. a
    // scratch one) pass this directly instead.
    String? metadataUrl,
    // Defaults to the real Flutter build mode — see checkOnce()'s guard. `flutter test` always runs
    // outside release mode, so tests that want to exercise checkOnce()'s real logic pass `true` here.
    bool? releaseMode,
    // Defaults to the real host OS. Tests force this to exercise the Linux packaging/relaunch branch
    // (a single downloaded file, no unpacking) from any host, since that branch needs no extra
    // tooling beyond the standard library, unlike ditto/plutil on macOS.
    bool? isLinux,
    // Defaults to the running CPU (`arm64`/`x64`): which Linux artifact to fetch, and whether the
    // Apple Silicon macOS build is on offer. Tests override it to exercise every key from any host.
    String? architecture,
  }) : _dio =
           dio ??
           Dio(
             BaseOptions(
               connectTimeout: const Duration(seconds: 10),
               receiveTimeout: const Duration(seconds: 30),
             ),
           ),
       _launchDetached = launchDetached ?? _defaultLaunchDetached,
       _metadataUrlForInstance = metadataUrl ?? _metadataUrl,
       _releaseMode = releaseMode ?? kReleaseMode,
       _isLinux = isLinux ?? Platform.isLinux,
       _architecture = architecture ?? _currentArchitecture();

  /// The manifest entries this build may install, most preferred first — [_newestEntry] takes the
  /// newest of them, an earlier key winning a tie.
  List<String> get _otaKeys {
    if (_isLinux) return ['desktop-linux-$_architecture'];
    // An Intel Mac reads only the Skia build: the arm64 one renders on Impeller, which is exactly
    // what it must not get, however new.
    if (_architecture != 'arm64') return const [_otaKeyMacOS];
    return const [_otaKeyMacOSArm64, _otaKeyMacOS];
  }

  /// Fetches the manifest and returns the newer entry, or null if this app is already current (or
  /// the manifest/network is unavailable — treated the same as "nothing to do", never surfaced as an
  /// error; this runs unattended in the background).
  ///
  /// A debug or profile build never reports an update — self-installing (swapping the running .app
  /// bundle for a downloaded release build and relaunching, see [applyStaged]) makes no sense for a
  /// local dev build and would silently clobber it mid-session.
  Future<UpdateInfo?> checkOnce({String? currentVersion}) async {
    if (!_releaseMode) return null;
    try {
      final running = currentVersion ?? await runningAppVersion();
      final response = await _dio.get<Map<String, dynamic>>(
        _metadataUrlForInstance,
      );
      final newest = _newestEntry(response.data);
      if (newest == null || !semverGt(newest.version, running)) return null;
      return newest;
    } catch (error) {
      debugPrint('DesktopUpdater.checkOnce: $error');
      return null;
    }
  }

  /// The newest of this host's [_otaKeys] entries, an earlier key winning a tie — so on Apple Silicon
  /// a release that published both macOS builds installs the Impeller one, while a release that only
  /// moved `desktop-macos` still reaches it instead of hiding behind an older arm64 entry.
  UpdateInfo? _newestEntry(Map<String, dynamic>? manifest) {
    UpdateInfo? newest;
    for (final key in _otaKeys) {
      final entry = _parseEntry(manifest?[key]);
      if (entry == null) continue;
      if (newest == null || semverGt(entry.version, newest.version)) {
        newest = entry;
      }
    }
    return newest;
  }

  /// One manifest entry, or null when it is missing or malformed — "nothing to install from this
  /// key", never an error.
  static UpdateInfo? _parseEntry(Object? entry) {
    if (entry is! Map) return null;
    final version = entry['version'];
    final url = entry['url'];
    final sha256 = entry['sha256'];
    final size = entry['size'];
    if (version is! String ||
        url is! String ||
        sha256 is! String ||
        size is! int) {
      return null;
    }
    return UpdateInfo(version: version, url: url, sha256: sha256, size: size);
  }

  /// Checks once immediately, then every [interval] — calls [onUpdateAvailable] each time a newer
  /// build is found (re-finding the same version on a later tick is harmless; the caller is expected
  /// to no-op if it's already showing that version). Cancel the returned [Timer] to stop.
  Timer startChecking({
    Duration interval = const Duration(minutes: 1),
    required void Function(UpdateInfo info) onUpdateAvailable,
    // Forwarded to checkOnce() on every tick — tests pass this to avoid checkOnce()'s default
    // runningAppVersion() call, which (via PackageInfo.fromPlatform()) needs a platform method
    // channel real production code gets for free but a plain `test()` doesn't.
    String? currentVersion,
  }) {
    void tick() {
      unawaited(
        checkOnce(currentVersion: currentVersion).then((info) {
          if (info != null) onUpdateAvailable(info);
        }),
      );
    }

    tick();
    return Timer.periodic(interval, (_) => tick());
  }

  /// Downloads [info] and verifies its sha256 BEFORE trusting the bytes. On macOS, unpacks the zip
  /// and confirms the staged bundle's own Info.plist really carries [info].version — the archive
  /// holds more than the hash alone authenticates. On Linux, the download itself is the artifact (a
  /// single AppImage file), so the sha256 check already covers everything there is: it is made
  /// executable and staged as-is, with nothing to unpack or recheck.
  /// Returns null (and cleans up anything partially written) on any verification failure.
  Future<StagedUpdate?> downloadAndStage(UpdateInfo info) async {
    Directory? stagingDir;
    try {
      final response = await _dio.get<List<int>>(
        info.url,
        options: Options(responseType: ResponseType.bytes),
      );
      final bytes = response.data;
      if (bytes == null || bytes.length != info.size) {
        debugPrint(
          'DesktopUpdater: unexpected download size for ${info.version}',
        );
        return null;
      }
      final hash = await Sha256().hash(bytes);
      final actualSha = hash.bytes
          .map((b) => b.toRadixString(16).padLeft(2, '0'))
          .join();
      if (actualSha != info.sha256) {
        debugPrint(
          'DesktopUpdater: sha256 mismatch for ${info.version} — discarding download',
        );
        return null;
      }

      stagingDir = await Directory.systemTemp.createTemp('harness-update-');

      if (_isLinux) {
        final appImagePath =
            '${stagingDir.path}/Harness-linux-$_architecture.AppImage';
        await File(appImagePath).writeAsBytes(bytes, flush: true);
        await Process.run('/bin/chmod', ['+x', appImagePath]);
        return StagedUpdate(
          version: info.version,
          bundlePath: appImagePath,
          stagingDirPath: stagingDir.path,
        );
      }

      final archivePath = '${stagingDir.path}/Harness-macos.zip';
      await File(archivePath).writeAsBytes(bytes, flush: true);

      final unpack = await Process.run('/usr/bin/ditto', [
        '-x',
        '-k',
        archivePath,
        stagingDir.path,
      ]);
      if (unpack.exitCode != 0) {
        debugPrint('DesktopUpdater: ditto unpack failed: ${unpack.stderr}');
        await stagingDir.delete(recursive: true);
        return null;
      }

      final bundlePath = '${stagingDir.path}/Harness.app';
      if (!Directory(bundlePath).existsSync()) {
        debugPrint(
          'DesktopUpdater: no Harness bundle inside the downloaded archive',
        );
        await stagingDir.delete(recursive: true);
        return null;
      }

      final plutil = await Process.run('/usr/bin/plutil', [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '$bundlePath/Contents/Info.plist',
      ]);
      final stagedVersion = plutil.exitCode == 0
          ? (plutil.stdout as String?)?.trim()
          : null;
      if (stagedVersion != info.version) {
        debugPrint(
          'DesktopUpdater: staged bundle reports version "$stagedVersion", expected "${info.version}"',
        );
        await stagingDir.delete(recursive: true);
        return null;
      }

      return StagedUpdate(
        version: info.version,
        bundlePath: bundlePath,
        stagingDirPath: stagingDir.path,
      );
    } catch (error) {
      debugPrint('DesktopUpdater.downloadAndStage: $error');
      try {
        await stagingDir?.delete(recursive: true);
      } catch (_) {
        // best-effort cleanup
      }
      return null;
    }
  }

  /// Hands off to a detached helper that waits for THIS process (pid [selfPid]) to exit, backs the
  /// running bundle up as `Harness.app.prev`, swaps [staged] into place, relaunches it, and restores
  /// the backup if the relaunch doesn't stay alive a few seconds later. Returns as soon as the helper
  /// has been spawned — the caller owns actually quitting (e.g. `exit(0)`) right after; this never
  /// exits the app itself, and never touches anything if [runningBundlePath] can't be resolved.
  Future<bool> applyStaged(
    StagedUpdate staged, {
    required int selfPid,
    String? runningBundlePath,
  }) async {
    final bundlePath =
        runningBundlePath ?? currentBundlePath(isLinux: _isLinux);
    if (bundlePath == null) {
      debugPrint(
        'DesktopUpdater: could not resolve the running bundle path — not applying',
      );
      return false;
    }
    final prevPath = '$bundlePath.prev';
    // On Linux, `bundlePath` IS the AppImage file (see currentBundlePath) — there is no enclosing
    // directory to exec into, so the "executable" is the swapped file itself. downloadAndStage()
    // already made staged.bundlePath executable, and mv preserves that bit across the swap below.
    final executableInBundle = _isLinux
        ? bundlePath
        : '$bundlePath/Contents/MacOS/Harness';
    // macOS relaunches through `open -n` (LaunchServices, so Dock/menu-bar identity stays correct).
    // Linux has no such registry for a plain packaged binary — exec it directly, detached from this
    // shell so it outlives the helper script.
    final relaunch = _isLinux
        ? 'nohup ${_singleQuote(executableInBundle)} >/dev/null 2>&1 & disown'
        : 'open -n ${_singleQuote(bundlePath)}';
    final command =
        '''
while kill -0 $selfPid 2>/dev/null; do sleep 0.2; done
rm -rf ${_singleQuote(prevPath)}
mv ${_singleQuote(bundlePath)} ${_singleQuote(prevPath)}
mv ${_singleQuote(staged.bundlePath)} ${_singleQuote(bundlePath)}
$relaunch
sleep 3
if pgrep -f ${_singleQuote(executableInBundle)} >/dev/null; then
  rm -rf ${_singleQuote(prevPath)}
else
  rm -rf ${_singleQuote(bundlePath)}
  mv ${_singleQuote(prevPath)} ${_singleQuote(bundlePath)}
  $relaunch
fi
rm -rf ${_singleQuote(staged.stagingDirPath)}
''';
    await _launchDetached(command);
    return true;
  }
}
