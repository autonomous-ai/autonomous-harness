/// A reference to an existing Codex state folder, reported by the harness CLI running on the
/// machine an agent will launch on (`AppNotifier.listCodexProfiles`/`linkCodexProfile`). This app
/// never scans a filesystem itself: discovery runs on that machine, which is what makes it work for
/// a remote machine too. No credentials are copied — this is a path and a display label only.
class LocalCodexProfile {
  const LocalCodexProfile(this.path, this.label);

  final String path;
  final String label;

  factory LocalCodexProfile.fromJson(Map<String, dynamic> json) =>
      LocalCodexProfile(
        json['path'] as String,
        json['label'] as String? ?? json['path'] as String,
      );
}
