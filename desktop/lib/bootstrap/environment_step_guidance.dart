import 'environment_provisioner.dart';

/// The exact command to hand the user for a step stuck in [EnvironmentStepStatus.failed] or
/// [EnvironmentStepStatus.needsTerminal], so they can run it themselves instead of only seeing a
/// generic "Retry" with no idea what actually needs to happen. Returns null for any step/status
/// combination that isn't a stuck, self-servable state.
String? environmentStepGuidanceCommand(
  EnvironmentStep step,
  EnvironmentStepStatus status, {
  required bool isMacOS,
}) {
  switch (step) {
    case EnvironmentStep.clipboard:
      if (status != EnvironmentStepStatus.failed &&
          status != EnvironmentStepStatus.needsTerminal) {
        return null;
      }
      return 'if [ -n "\${WAYLAND_DISPLAY:-}" ]; then sudo apt-get install -y wl-clipboard; else sudo apt-get install -y xclip; fi';
    case EnvironmentStep.harness:
      if (status != EnvironmentStepStatus.failed) return null;
      // Same URL _ensureHarness() itself curls — see environment_provisioner.dart.
      return kHarnessDesktopInstallCommand;
    case EnvironmentStep.tmux:
      if (status == EnvironmentStepStatus.needsTerminal) {
        return isMacOS
            ? '/bin/bash -c "\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install tmux'
            : 'sudo apt-get install -y tmux';
      }
      if (status == EnvironmentStepStatus.failed) {
        // The only way tmux itself reaches `failed` rather than `needsTerminal` is a Homebrew
        // install that ran and errored (see _ensureTmux) — Homebrew is already present.
        return 'brew install tmux';
      }
      return null;
  }
}

/// A short explanation to sit above the command — kept separate from the command itself so the
/// command block stays copy-paste clean.
String environmentStepGuidanceText(
  EnvironmentStep step,
  EnvironmentStepStatus status, {
  required bool isMacOS,
}) {
  switch (step) {
    case EnvironmentStep.clipboard:
      return status == EnvironmentStepStatus.needsTerminal
          ? 'The clipboard package is part of the single Host dependencies install. Finish the existing Terminal prompt; do not start a second installer.'
          : 'Install the clipboard helper for the active Linux display, then click Recheck.';
    case EnvironmentStep.harness:
      return 'Run this in a terminal, then click Recheck.';
    case EnvironmentStep.tmux:
      if (status == EnvironmentStepStatus.needsTerminal) {
        final opened = isMacOS
            ? 'A Terminal window was opened to install Homebrew and tmux — finish any prompts there.'
            : 'A terminal window was opened to install tmux — finish any prompts there.';
        final manual = isMacOS
            ? "If it didn't open, or you'd rather run it yourself:"
            : "If it didn't open, or you'd rather run it yourself (on a non-apt "
                  "distribution, use your own package manager instead):";
        return '$opened $manual';
      }
      return 'Homebrew is installed but the tmux install itself failed. Run it again yourself:';
  }
}
