/// Whether one engine exists on one machine, as that machine answered it.
///
/// The New Agent dialog lists every engine Harness supports; a machine holds
/// whichever subset someone installed on it. Until this existed the difference
/// only surfaced as a failed create — tmux ran a command that was not there and
/// the pane said `command not found` — which is a late and confusing way to
/// learn that Hermes was never on this box.
///
/// **Answered per machine, never computed here.** A developer's Mac and the
/// Docker rig in the CLI repo routinely disagree (the rig ships exactly one
/// engine on purpose), and so do two laptops on one account. The app asks the
/// machine (`engines_probe`) and renders what comes back; deciding locally
/// would be wrong for precisely the remote case the feature exists for.
library;

class EngineAvailability {
  const EngineAvailability({
    required this.engine,
    required this.installed,
    this.command,
    this.supportsCodexHome = false,
    this.installable = false,
    this.installCommand,
  });

  final String engine;

  /// Does the launch command resolve as an existing executable file, in the
  /// same interactive shell a create launches through?
  ///
  /// That shell is the point: a detached daemon does not carry the user's PATH,
  /// and the probe additionally tests that what resolved is a real file — so a
  /// dangling symlink (a `hermes` pointing into a deleted venv) reads as not
  /// installed, which is the state a bare `command -v` gets wrong.
  final bool installed;

  /// The command that was probed — `command[0]` of a launch. Null when the
  /// machine could not name one, which on a real box means the binary is
  /// ambiguous rather than absent (the `agent` alias Cursor and Grok share).
  final String? command;

  /// Explicit capability: older CLIs otherwise ignore a requested profile.
  final bool supportsCodexHome;

  /// Whether this machine can be offered an install for it. False when the
  /// engine is already there, and false when Harness has no line to cite.
  final bool installable;

  /// The exact line that would run, as the machine that would run it named it.
  /// Shown before the click: installing software on someone's computer — and
  /// [installable] covers remote ones — is not a thing to do unannounced.
  final String? installCommand;

  static EngineAvailability? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final engine = raw['engine'];
    if (engine is! String || engine.isEmpty) return null;
    final command = raw['command'];
    final installCommand = raw['installCommand'];
    return EngineAvailability(
      engine: engine,
      installed: raw['installed'] == true,
      command: command is String && command.isNotEmpty ? command : null,
      supportsCodexHome: engine == 'codex' && raw['supportsCodexHome'] == true,
      installable: raw['installable'] == true,
      installCommand: installCommand is String && installCommand.isNotEmpty
          ? installCommand
          : null,
    );
  }
}

/// One machine's answers, plus enough state to tell "still asking" apart from
/// "asked, and it has nothing".
///
/// Those two must not render the same — the app's rule everywhere else, and it
/// matters most here: labelling a row "not installed" while the probe is still
/// running is a claim the app has not earned, and it would send someone to
/// install an engine they already have.
class MachineEngines {
  MachineEngines();

  final Map<String, EngineAvailability> byEngine = {};

  /// True once a probe has answered at least once. Never reset by a refresh, so
  /// a re-probe leaves the rows already on screen rather than blanking them.
  bool loaded = false;

  /// A probe is in flight. Held so a dialog opening twice does not start two.
  Future<void>? inFlight;

  /// Set when the machine could not answer. The dialog stays usable: an unknown
  /// engine is offered exactly as it was before this feature existed.
  String? error;

  EngineAvailability? operator [](String engine) => byEngine[engine];

  void replace(Iterable<EngineAvailability> entries) {
    byEngine
      ..clear()
      ..addEntries(entries.map((entry) => MapEntry(entry.engine, entry)));
    loaded = true;
    error = null;
  }
}
