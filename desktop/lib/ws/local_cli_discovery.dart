import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../core/serial_port_lease.dart';
import '../core/config.dart';
import '../core/harness_cli_runner.dart';
import '../core/harness_file_store.dart';
import '../core/models.dart';

const localWsProtocolVersion = 1;
const localTerminalProtocolVersion = 3;

class LocalCliEndpoint {
  final String computerId;
  final Uri wsUri;
  final int protocolVersion;
  final int terminalProtocolVersion;

  /// Older daemons report local working folders in status before they support
  /// project metadata in agent frames. This snapshot never describes a peer.
  final Map<String, AgentProject> agentProjects;

  const LocalCliEndpoint({
    required this.computerId,
    required this.wsUri,
    required this.protocolVersion,
    required this.terminalProtocolVersion,
    this.agentProjects = const {},
  });
}

/// Reads the stable identity shared by the Harness CLI and backend machine record.
class LocalMachineIdentity {
  final File computerIdFile;
  final Map<String, String> environment;

  LocalMachineIdentity({File? computerIdFile, Map<String, String>? environment})
    : environment = environment ?? Platform.environment,
      computerIdFile =
          computerIdFile ??
          File(defaultComputerIdPath(environment: environment));

  static String defaultComputerIdPath({Map<String, String>? environment}) {
    final desktopDirectory = HarnessFileStore.defaultDirectoryPath(
      environment: environment,
    );
    final harnessHome = Directory(desktopDirectory).parent.path;
    return _joinPath(harnessHome, 'computer-id');
  }

  Future<String?> computerId() async {
    final pinned = _normalizeComputerId(environment['ADAPTER_COMPUTER_ID']);
    if (pinned != null) return pinned;
    try {
      final id = (await computerIdFile.readAsString()).trim();
      return _normalizeComputerId(id);
    } catch (_) {
      return null;
    }
  }
}

String _joinPath(String parent, String child) =>
    '$parent${Platform.pathSeparator}$child';

/// Discovers only the CLI bound to the fixed loopback address. The response
/// advertises capabilities but never contains the machine API key.
/// Starts the owned CLI directly. Finder does not need a shell/PATH in order
/// to locate the managed Node runtime and CLI bundle.
///
/// A non-zero exit is a FAILED spawn and must read as one: the CLI exits 1
/// when it could not start (a port clash, a spawn lock it gave up waiting on)
/// and 0 for every "fine, nothing to do" (already running, still connecting,
/// busy elsewhere) — which is exactly the signal the supervisor's backoff
/// wants. It used to swallow the code, so a `harness start` that failed
/// outright looked like one that worked.
Future<void> runHarnessStart(HarnessCliRunner runner) async {
  final result = await runner.run(['start']);
  if (result.exitCode != 0) {
    throw ProcessException(
      'harness',
      const ['start'],
      '${result.stderr}'.trim().isEmpty
          ? '${result.stdout}'.trim()
          : '${result.stderr}'.trim(),
      result.exitCode,
    );
  }
}

Future<void> _defaultSpawnCommand() => runHarnessStart(HarnessCliRunner());

/// What one look at the daemon's control port found.
///
/// THREE answers, not two, and the middle one is the point. A port that
/// nobody answers on means the daemon is down and spawning it is the fix. A
/// port that answers but is not yet ready — a daemon that just came up after
/// a self-update and has not finished its backend handshake, or one still
/// scanning for agents — means a daemon is RUNNING, and spawning another can
/// only fail on the port it already holds. Collapsing the two into "not
/// ready" had the supervisor re-running `harness start` every few seconds
/// for the whole length of every update, and the boot path calling a daemon
/// that was busy connecting "did not start".
enum LocalCliProbeState { down, notReady, ready }

class LocalCliProbe {
  final LocalCliProbeState state;

  /// Non-null exactly when [state] is [LocalCliProbeState.ready].
  final LocalCliEndpoint? endpoint;

  /// Why it is not ready, for a log line or an error strip. Null when ready.
  final String? reason;

  /// What the daemon said about itself, when it answered at all.
  final int? pid;
  final String? version;

  const LocalCliProbe._({
    required this.state,
    this.endpoint,
    this.reason,
    this.pid,
    this.version,
  });

  const LocalCliProbe.down(String reason)
    : this._(state: LocalCliProbeState.down, reason: reason);

  const LocalCliProbe.notReady(String reason, {int? pid, String? version})
    : this._(
        state: LocalCliProbeState.notReady,
        reason: reason,
        pid: pid,
        version: version,
      );

  const LocalCliProbe.ready(
    LocalCliEndpoint endpoint, {
    int? pid,
    String? version,
  }) : this._(
         state: LocalCliProbeState.ready,
         endpoint: endpoint,
         pid: pid,
         version: version,
       );

  /// Something owns the port and answers on it — whether or not it is ready.
  bool get alive => state != LocalCliProbeState.down;
  bool get ready => state == LocalCliProbeState.ready;

  @override
  String toString() =>
      'LocalCliProbe(${state.name}${reason == null ? '' : ': $reason'})';
}

class LocalCliDiscovery {
  final AppConfig config;
  final Dio _dio;
  final LocalMachineIdentity identity;
  final Future<void> Function() _spawnCommand;

  LocalCliDiscovery({
    required this.config,
    Dio? dio,
    LocalMachineIdentity? identity,
    Future<void> Function()? spawnCommand,
  }) : identity = identity ?? LocalMachineIdentity(),
       _spawnCommand = spawnCommand ?? _defaultSpawnCommand,
       _dio =
           dio ??
           Dio(
             BaseOptions(
               connectTimeout: const Duration(milliseconds: 400),
               receiveTimeout: const Duration(milliseconds: 400),
               sendTimeout: const Duration(milliseconds: 400),
             ),
           );

  Future<String?> computerId() => identity.computerId();

  /// How long a daemon that ANSWERS is given to become ready before
  /// [ensureRunning] gives up waiting on it. Long, because the common reason
  /// is a backend handshake after a self-update restart, and the daemon keeps
  /// retrying that on its own — there is nothing to do here but wait.
  static const Duration defaultReadyTimeout = Duration(seconds: 45);

  /// Makes sure the local `harness` daemon is up and answering `/api/status`, spawning `harness
  /// start` ONLY if a probe finds nobody on the port — every local REST/WS call needs this daemon
  /// running, and unlike `harness login` it does not start on its own. A daemon that answers but is
  /// not ready yet is waited on (up to [readyTimeout]) rather than spawned over: it is already
  /// running, and a second one can only fail on the port. Returns the last probe, so a caller can
  /// tell "never came up" from "up, still connecting" — the two call for different words.
  Future<LocalCliProbe> ensureRunning({
    Duration timeout = const Duration(seconds: 15),
    Duration readyTimeout = defaultReadyTimeout,
  }) async {
    var last = await probe();
    if (last.ready) return last;
    if (!last.alive) {
      // Same reason as the supervisor: while the dial is being flashed the daemon is down on purpose
      // and its port belongs to esptool. Down is the honest answer here — it really is not running.
      if (SerialPortLease.held || SerialPortLease.heldByAnotherProcess()) {
        return last;
      }
      try {
        await _spawnCommand();
      } catch (_) {
        return last;
      }
      final deadline = DateTime.now().add(timeout);
      while (!last.alive && DateTime.now().isBefore(deadline)) {
        await Future.delayed(const Duration(milliseconds: 500));
        last = await probe();
      }
      if (last.ready || !last.alive) return last;
    }
    // Alive, not ready. Wait for it — and if it goes DOWN meanwhile (it was a daemon on its way
    // out, say), fall back to one spawn rather than sitting on a port that just went quiet.
    final deadline = DateTime.now().add(readyTimeout);
    var spawned = false;
    while (DateTime.now().isBefore(deadline)) {
      await Future.delayed(const Duration(milliseconds: 500));
      last = await probe();
      if (last.ready) return last;
      if (!last.alive) {
        if (spawned ||
            SerialPortLease.held ||
            SerialPortLease.heldByAnotherProcess()) {
          return last;
        }
        spawned = true;
        try {
          await _spawnCommand();
        } catch (_) {
          return last;
        }
      }
    }
    return last;
  }

  /// Keeps the local daemon alive for as long as the returned [Timer] runs: polls [probe] every
  /// [checkInterval] and, when the port has gone quiet, spawns `harness start` and gives it a short
  /// grace window to bind its port before concluding the attempt failed. Failed spawn attempts back
  /// off exponentially (capped) so a persistently broken environment doesn't spin — the poll itself
  /// keeps going at [checkInterval] regardless, since backoff only gates the next SPAWN, not the next
  /// probe.
  ///
  /// A daemon that ANSWERS but is not ready is left alone, however long that lasts: it is running,
  /// it is the one that has to finish, and a `harness start` beside it can only fail. That is the
  /// state a daemon sits in for the length of every self-update's backend handshake, and it is what
  /// this loop used to spawn into every few seconds.
  ///
  /// Spawning waits for [spawnAfter] consecutive quiet ticks rather than one: a self-update leaves
  /// the port unowned for a second or two between the old daemon closing it and the new one binding,
  /// and a spawn into that gap is a wasted process (the CLI's own lock refuses it), not a fix.
  ///
  /// Never surfaces ORDINARY failures to the caller (no exceptions, no
  /// [AppNotifier]-visible error); [onSignedOut] is the single exception, for the one state no
  /// amount of respawning can recover from —
  /// this runs unattended in the background for the app's whole lifetime; callers that need a
  /// one-shot "start now and tell me if it worked" should use [ensureRunning] instead. Cancel the
  /// timer to stop supervising — this never touches the daemon process itself (it self-daemonizes and
  /// must keep running after the app quits, see `harness_daemon_keep_alive` plan).
  ///
  /// [onReady] fires on every transition INTO ready — the daemon coming back after an update, or
  /// after a spawn — so the app can pick up where it left off without a click.
  /// [onSnapshot] receives each ready probe, including changing local working folders.
  Timer startSupervising({
    Duration checkInterval = const Duration(seconds: 5),
    Duration graceStep = const Duration(milliseconds: 500),
    Duration graceWindow = const Duration(seconds: 5),
    Duration initialBackoff = const Duration(seconds: 2),
    Duration maxBackoff = const Duration(seconds: 30),
    int spawnAfter = 2,
    Future<bool> Function()? stillSignedIn,
    void Function()? onSignedOut,
    void Function(LocalCliEndpoint endpoint)? onReady,
    void Function(LocalCliEndpoint endpoint)? onSnapshot,
  }) {
    var backoff = initialBackoff;
    var nextSpawnAllowedAt = DateTime.now();
    var quietTicks = 0;
    var wasReady = false;
    // A spawn+grace-window cycle can outlast `checkInterval` — without this, an overlapping tick
    // would race a second `harness start` before the first cycle's backoff state even lands (the same
    // "port already in use" failure mode a second concurrent spawn hits today).
    var cycleInFlight = false;

    void failedSpawn() {
      nextSpawnAllowedAt = DateTime.now().add(backoff);
      backoff = (backoff * 2) > maxBackoff ? maxBackoff : backoff * 2;
    }

    void observe(LocalCliProbe seen) {
      if (seen.ready) {
        backoff = initialBackoff;
        quietTicks = 0;
        onSnapshot?.call(seen.endpoint!);
        if (!wasReady) onReady?.call(seen.endpoint!);
        wasReady = true;
        return;
      }
      wasReady = false;
      if (seen.alive) quietTicks = 0;
    }

    late final Timer timer;
    timer = Timer.periodic(checkInterval, (_) {
      if (cycleInFlight) return;
      cycleInFlight = true;
      unawaited(() async {
        try {
          // The daemon is DELIBERATELY down while the dial is being flashed — it was stopped so the
          // port could be handed over. Starting it here takes the port back mid-write and kills the
          // flash, which is what made a firmware update fail at a few tens of kilobytes.
          if (SerialPortLease.held || SerialPortLease.heldByAnotherProcess()) {
            return;
          }
          final seen = await probe();
          observe(seen);
          // Running — ready or on its way. Nothing to spawn, nothing to back off from.
          if (seen.alive) return;
          quietTicks += 1;
          if (quietTicks < spawnAfter) return;
          if (DateTime.now().isBefore(nextSpawnAllowedAt)) return;
          // A daemon that signed itself OUT — its machine was deleted from another machine, or its
          // session expired — deletes its session file and exits. Respawning it is the one failure
          // this loop cannot fix: every replacement starts without a session and exits again,
          // forever, silently. Stop instead, and let the caller send the user somewhere that helps.
          //
          // Asked here and not on every tick because it costs a `harness auth status` process, and
          // the respawn point is already rate-limited by the backoff above — so this runs once per
          // spawn attempt rather than once every [checkInterval].
          if (stillSignedIn != null && !await stillSignedIn()) {
            timer.cancel();
            onSignedOut?.call();
            return;
          }
          try {
            await _spawnCommand();
          } catch (error) {
            debugPrint(
              'LocalCliDiscovery.startSupervising: spawn failed: $error',
            );
            failedSpawn();
            return;
          }
          // The grace window ends the moment SOMETHING answers on the port — bound is what the
          // spawn was for; ready is the daemon's own business from there.
          final deadline = DateTime.now().add(graceWindow);
          while (DateTime.now().isBefore(deadline)) {
            await Future.delayed(graceStep);
            final after = await probe();
            observe(after);
            if (after.alive) return;
          }
          failedSpawn();
        } finally {
          cycleInFlight = false;
        }
      }());
    });
    return timer;
  }

  /// The ready endpoint, or null. Kept for the callers that only ever wanted
  /// "can I dial it now" — see [probe] for the three-way answer.
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      (await probe(expectedComputerId: expectedComputerId)).endpoint;

  Future<LocalCliProbe> probe({String? expectedComputerId}) async {
    final localComputerId = await computerId();
    if (localComputerId == null) {
      return const LocalCliProbe.down(
        'this computer has no Harness identity yet',
      );
    }
    if (expectedComputerId != null && expectedComputerId != localComputerId) {
      return const LocalCliProbe.down('computer id mismatch');
    }
    final base = Uri.parse(config.localCliBaseUrl);
    if (base.host != '127.0.0.1' && base.host != 'localhost') {
      return const LocalCliProbe.down('the local CLI address is not loopback');
    }
    final Map<String, dynamic>? body;
    try {
      final response = await _dio.getUri<Map<String, dynamic>>(
        base.resolve('/api/status'),
      );
      body = response.data;
    } on DioException catch (error) {
      switch (error.type) {
        // Nobody on the port. The one case where spawning helps — and still
        // not on the first sighting: an update handoff leaves the port unowned
        // for a second or two between the old daemon closing it and the new
        // one binding, so the supervisor waits for a SECOND quiet tick (see
        // [startSupervising]'s `spawnAfter`). A single `down` is not proof.
        case DioExceptionType.connectionError:
        case DioExceptionType.connectionTimeout:
          return const LocalCliProbe.down('connection refused');
        // Something owns the port — a daemon mid-boot, a foreign process, a
        // daemon too busy to answer in time. Spawning over it can only fail.
        case DioExceptionType.badResponse:
          return LocalCliProbe.notReady(
            'http ${error.response?.statusCode ?? '?'} from the control port',
          );
        case DioExceptionType.receiveTimeout:
        case DioExceptionType.sendTimeout:
          return const LocalCliProbe.notReady('timed out answering');
        case DioExceptionType.badCertificate:
        case DioExceptionType.cancel:
        case DioExceptionType.transformTimeout:
        case DioExceptionType.unknown:
          // A refused socket surfaces as `unknown` wrapping the SocketException
          // on older adapters — still nobody on the port. A socket that was
          // ACCEPTED and then dropped (an HttpException, "connection closed
          // while receiving") is not: something answered, then went away —
          // the old daemon mid-close, say — and that reads as alive.
          if (error.error is SocketException) {
            return const LocalCliProbe.down('connection refused');
          }
          return LocalCliProbe.notReady(error.message ?? 'unexpected answer');
      }
    } catch (error) {
      return LocalCliProbe.notReady('unexpected answer: $error');
    }
    final pid = body?['pid'] is int ? body!['pid'] as int : null;
    final version = body?['version'] is String
        ? body!['version'] as String
        : null;
    if (body == null) {
      return const LocalCliProbe.notReady('not a harness status');
    }
    // New CLIs expose the initial terminal scan explicitly. A missing field means an older CLI and
    // remains accepted for backward compatibility; false means the daemon is alive but not ready to
    // publish an authoritative empty/non-empty agent list yet.
    if (body['discoveryReady'] == false) {
      return LocalCliProbe.notReady(
        'still scanning for agents',
        pid: pid,
        version: version,
      );
    }
    // `discoveryReady` is local-only (tmux/agent-process scanning) and can go true well before the
    // daemon has actually connected to the backend — `/api/machines` and friends proxy straight to
    // it, so treating discovery-ready as "ready" raced the handshake and surfaced as a bogus 30s
    // receive-timeout right after boot. `connected` is the daemon's own backend-socket state
    // (missing field ⇒ older CLI ⇒ accepted, same idiom as above).
    if (body['connected'] == false) {
      return LocalCliProbe.notReady(
        'not connected to the backend yet',
        pid: pid,
        version: version,
      );
    }
    final advertisedComputerId = _normalizeComputerId(body['computerId']);
    final advertised = body['localWs'];
    if (advertisedComputerId != localComputerId) {
      return LocalCliProbe.notReady(
        'a daemon for a different computer',
        pid: pid,
        version: version,
      );
    }
    if (advertised is! Map) {
      return LocalCliProbe.notReady(
        'not a harness status',
        pid: pid,
        version: version,
      );
    }
    final localWs = Map<String, dynamic>.from(advertised);
    final path = localWs['path'];
    final protocolVersion = localWs['protocolVersion'];
    final terminalProtocolVersion = localWs['terminalProtocolVersion'];
    if (path is! String ||
        !path.startsWith('/') ||
        protocolVersion != localWsProtocolVersion ||
        terminalProtocolVersion != localTerminalProtocolVersion ||
        localWs['e2ee'] != false) {
      return LocalCliProbe.notReady(
        'protocol mismatch',
        pid: pid,
        version: version,
      );
    }
    return LocalCliProbe.ready(
      LocalCliEndpoint(
        computerId: localComputerId,
        wsUri: base
            .resolve(path)
            .replace(scheme: base.scheme == 'https' ? 'wss' : 'ws'),
        protocolVersion: protocolVersion as int,
        terminalProtocolVersion: terminalProtocolVersion as int,
        agentProjects: _localAgentProjects(
          body['sessions'],
          identity.environment,
        ),
      ),
      pid: pid,
      version: version,
    );
  }
}

Map<String, AgentProject> _localAgentProjects(
  Object? sessions,
  Map<String, String> environment,
) {
  if (sessions is! List) return const {};
  final projects = <String, AgentProject>{};
  final home = environment['HOME'] ?? environment['USERPROFILE'];
  for (final session in sessions) {
    if (session is! Map || session['id'] is! String) continue;
    final id = session['id'] as String;
    final rawCwd = session['cwd'];
    if (id.isEmpty ||
        rawCwd is! String ||
        rawCwd.isEmpty ||
        rawCwd.length > 4096 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(rawCwd)) {
      continue;
    }
    String cwd = rawCwd;
    if (cwd == '~' ||
        cwd.startsWith('~/') ||
        (Platform.isWindows && cwd.startsWith('~\\'))) {
      if (home == null || home.isEmpty) continue;
      cwd = '$home${cwd.substring(1)}';
    }
    final absolute = Platform.isWindows
        ? RegExp(r'^[A-Za-z]:[\\/]|^\\\\').hasMatch(cwd)
        : cwd.startsWith('/');
    if (!absolute) continue;
    try {
      cwd = File(cwd).uri.normalizePath().toFilePath();
      // Directory paths in the status may carry a trailing separator.
      final separator = Platform.pathSeparator;
      while (cwd.length > 1 &&
          cwd.endsWith(separator) &&
          !(Platform.isWindows && RegExp(r'^[A-Za-z]:\\$').hasMatch(cwd))) {
        cwd = cwd.substring(0, cwd.length - 1);
      }
      final parts = cwd.split(separator).where((part) => part.isNotEmpty);
      final project = AgentProject.fromJson({
        'name': parts.isEmpty ? cwd : parts.last,
        'cwd': cwd,
      });
      if (project != null) projects[id] = project;
    } on FormatException {
      // A malformed status row must not prevent discovery of the daemon.
    }
  }
  return Map.unmodifiable(projects);
}

String? _normalizeComputerId(Object? raw) {
  if (raw is! String) return null;
  final value = raw.trim().toLowerCase().replaceAll('-', '');
  return RegExp(r'^[a-f0-9]{16,64}$').hasMatch(value) ? value : null;
}
