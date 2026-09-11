import 'dart:io';

/// The machine's name exactly as the OS gives it, or null when it has none.
///
/// Guarded because `localHostname` throws where the OS refuses to answer, and
/// its callers run inside builds — not a place to take an exception over a
/// label.
String? localHostnameOrNull() {
  try {
    final host = Platform.localHostname.trim();
    return host.isEmpty ? null : host;
  } catch (_) {
    return null;
  }
}
