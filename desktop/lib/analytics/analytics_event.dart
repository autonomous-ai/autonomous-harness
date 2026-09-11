import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'analytics_config.dart';

/// The name rule this app holds itself to: `snake_case`, 3–64 characters.
///
/// Autonomous Analytics accepts anything — the website sends whole sentences
/// (`"Click button add to cart"`) — which is exactly why a rule is worth having
/// here. A stream where the same action is called three things is a stream
/// nobody can query, and the app is the only place that can prevent it.
final RegExp analyticsEventNamePattern = RegExp(r'^[a-z][a-z0-9_]{2,63}$');

/// The machine, the build and the OS an event happened on. Resolved once per
/// launch and attached to every event.
@immutable
class AnalyticsContext {
  const AnalyticsContext({
    required this.platform,
    required this.appVersion,
    required this.appBuild,
    required this.osVersion,
    required this.arch,
    required this.locale,
    required this.release,
  });

  /// `macos`, `windows` or `linux`. The website sends `web` in this field; the
  /// app says which desktop it is, because that is the first question asked of
  /// a desktop funnel.
  final String platform;

  final String appVersion;

  /// The `+N` build behind [appVersion]. Note that this app's `pubspec.yaml`
  /// version is a placeholder — the published version comes from the remote GCS
  /// manifest — so this field tells builds apart, it does not name a release.
  final String appBuild;

  final String osVersion;

  /// `macosArm64`, `macosX64`, … — an Intel Mac and an Apple Silicon one are
  /// different products as far as running agents and models locally goes.
  final String arch;

  final String locale;

  /// False in a developer build. Sent on every event so analysis can drop the
  /// noise our own machines make instead of guessing at it.
  final bool release;

  /// Stand-in for a context that could not be read, so an event still goes out
  /// with its name and identity rather than being dropped over a version
  /// lookup.
  static const AnalyticsContext unknown = AnalyticsContext(
    platform: '',
    appVersion: '',
    appBuild: '',
    osVersion: '',
    arch: '',
    locale: '',
    release: kReleaseMode,
  );

  /// The context as event params. Empty strings are dropped downstream, so a
  /// half-resolved context costs the missing fields and nothing else.
  Map<String, Object?> asParams() => {
    'app_version': appVersion.isEmpty ? null : appVersion,
    'app_build': appBuild.isEmpty ? null : appBuild,
    'os': platform.isEmpty ? null : platform,
    'os_version': osVersion.isEmpty ? null : osVersion,
    'arch': arch.isEmpty ? null : arch,
    'locale': locale.isEmpty ? null : locale,
    'build': release ? 'release' : 'debug',
  };
}

/// Who an event belongs to and which visit it is part of.
@immutable
class AnalyticsIdentity {
  const AnalyticsIdentity({
    required this.pseudoId,
    required this.sessionId,
    this.userId,
    this.userEmail,
  });

  /// The device id — stable for the life of the machine, present whether or not
  /// anyone is signed in. See `AnalyticsIdentityStore`.
  final String pseudoId;

  /// The visit id, rotated after quiet (`AnalyticsLimits.sessionIdle`).
  final String sessionId;

  /// The signed-in account, or null before sign-in. The account id the CLI
  /// reports through `api.me()` — stable, and not something a user typed.
  final String? userId;

  /// Sent as a param, mirroring the website, so the same person can be found in
  /// both streams. Null while signed out.
  final String? userEmail;
}

/// One event, as it sits in the queue and goes on the wire.
@immutable
class AnalyticsEvent {
  const AnalyticsEvent({
    required this.name,
    required this.params,
    required this.at,
    required this.identity,
  });

  final String name;
  final Map<String, Object?> params;

  /// When the event *happened*, not when it was flushed — a queue that drains
  /// after a reconnect must not report an hour of activity as one instant.
  final DateTime at;

  final AnalyticsIdentity identity;
}

/// The Autonomous Analytics request body for [event].
///
/// Pure, so the wire format is checked by reading one function rather than by
/// watching a queue. The shape is the web client's: an envelope naming the
/// event and its timestamp, with everything else under `data`, and the params
/// as a `{key, value}` list.
///
/// `user_id` goes in both `data` and the params, as it does on the web — most
/// queries read the params table, and dropping it from there would make the
/// app's events the only ones that cannot be filtered by account.
Map<String, Object?> analyticsPayload(
  AnalyticsEvent event,
  AnalyticsContext context,
) {
  final identity = event.identity;
  // Merged as a map, not appended to a list: a later key simply wins, so an
  // event that wants to say more about `model` than the context did needs no
  // de-duplication pass afterwards (the web has one because it uses a list).
  final params = <String, Object?>{
    ...context.asParams(),
    'user_id': identity.userId,
    'user_email': identity.userEmail,
    ...event.params,
    'category': AnalyticsConfig.category,
  };
  return {
    'event_name': event.name,
    'event_timestamp': event.at.millisecondsSinceEpoch ~/ 1000,
    'data': {
      'session_id': identity.sessionId,
      'user_pseudo_id': identity.pseudoId,
      if (identity.userId != null) 'user_id': identity.userId,
      'platform': context.platform,
      'event_params': analyticsParams(params),
    },
  };
}

/// [params] as the wire's `{key, value}` list: nulls dropped, nested values
/// JSON-encoded, long strings clipped, and never more than
/// `AnalyticsLimits.paramsMaxKeys` entries.
List<Map<String, Object?>> analyticsParams(Map<String, Object?> params) {
  final out = <Map<String, Object?>>[];
  for (final entry in params.entries) {
    final value = entry.value;
    if (value == null) continue;
    if (value is String && value.isEmpty) continue;
    if (out.length >= AnalyticsLimits.paramsMaxKeys) break;
    out.add({'key': entry.key, 'value': analyticsValue(value)});
  }
  return out;
}

/// One param value the backend can store: a string, a number or a bool.
/// Anything else is JSON-encoded (the website does the same), and anything long
/// is clipped to `AnalyticsLimits.paramsMaxStringLength`.
Object analyticsValue(Object value) {
  final encoded = switch (value) {
    String() || num() || bool() => value,
    _ => _encode(value),
  };
  if (encoded is! String) return encoded;
  return encoded.length > AnalyticsLimits.paramsMaxStringLength
      ? encoded.substring(0, AnalyticsLimits.paramsMaxStringLength)
      : encoded;
}

/// JSON, or the value's own `toString` when it isn't encodable — a param that
/// cannot be serialised must cost that param, never the event.
String _encode(Object value) {
  try {
    return jsonEncode(value);
  } on Object {
    return value.toString();
  }
}
