import '../core/config.dart';
import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';

/// Persists user-configurable connection settings in the Harness home file.
class ConfigStore {
  final LocalKeyValueStore _storage;
  static const _baseUrlKey = 'app_api_base_url';
  static const _environmentKey = 'app_autonomous_environment';
  static const _skippedDesktopUpdateVersionKey =
      'skipped_desktop_update_version';
  // No longer read or written: live pre-flight runs on every launch. Kept only
  // so Reset can clean state written by older desktop builds.
  static const _legacyEnvironmentSetupVersionKey = 'environment_setup_version';
  static const String defaultBaseUrl = 'https://harness-api.autonomous.ai';

  ConfigStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared;

  AppConfig get config => AppConfig(
    apiBaseUrl: _cachedBaseUrl ?? defaultBaseUrl,
    autonomousEnv: _cachedEnvironment ?? 'prod',
  );
  String? _cachedBaseUrl;
  String? _cachedEnvironment;
  String? _cachedSkippedDesktopUpdateVersion;

  String? get skippedDesktopUpdateVersion => _cachedSkippedDesktopUpdateVersion;

  Future<AppConfig> load() async {
    // ⚠️ **One `readMany`, not three `read`s, and the difference is not cosmetic.**
    // Every operation on [HarnessFileStore] takes an exclusive file lock and
    // re-parses the whole of `state.json`, and they are queued process-wide — so
    // three reads of three keys from one file cost three locks and three parses,
    // strictly one after another, on the launch path. `readMany` answers all
    // three from a single locked read. These keys are also a consistent set: a
    // base URL from before a write and an environment from after it would
    // describe a backend that was never configured.
    final saved = await _storage.readMany([
      _baseUrlKey,
      _environmentKey,
      _skippedDesktopUpdateVersionKey,
    ]);
    final baseUrl = saved[_baseUrlKey];
    final environment = saved[_environmentKey];
    final skippedUpdate = saved[_skippedDesktopUpdateVersionKey];
    _cachedBaseUrl = baseUrl ?? defaultBaseUrl;
    _cachedEnvironment = environment == 'stag' ? 'stag' : 'prod';
    _cachedSkippedDesktopUpdateVersion = skippedUpdate?.trim().isEmpty ?? true
        ? null
        : skippedUpdate!.trim();
    return config;
  }

  Future<void> save(String baseUrl) async {
    _cachedBaseUrl = baseUrl;
    await _storage.write(_baseUrlKey, baseUrl);
  }

  Future<void> saveEnvironment(String autonomousEnv) async {
    _cachedEnvironment = autonomousEnv == 'stag' ? 'stag' : 'prod';
    await _storage.write(_environmentKey, _cachedEnvironment!);
  }

  Future<void> saveSkippedDesktopUpdateVersion(String? version) async {
    final normalized = version?.trim();
    _cachedSkippedDesktopUpdateVersion =
        normalized == null || normalized.isEmpty ? null : normalized;
    if (_cachedSkippedDesktopUpdateVersion == null) {
      await _storage.delete(_skippedDesktopUpdateVersionKey);
    } else {
      await _storage.write(
        _skippedDesktopUpdateVersionKey,
        _cachedSkippedDesktopUpdateVersion!,
      );
    }
  }

  Future<void> reset() async {
    _cachedBaseUrl = null;
    _cachedEnvironment = null;
    _cachedSkippedDesktopUpdateVersion = null;
    await Future.wait([
      _storage.delete(_baseUrlKey),
      _storage.delete(_environmentKey),
      _storage.delete(_skippedDesktopUpdateVersionKey),
      _storage.delete(_legacyEnvironmentSetupVersionKey),
    ]);
  }
}
