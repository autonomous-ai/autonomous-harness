import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../bootstrap/environment_provisioner.dart';
import '../shared/widgets/command_row.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';

/// Transparent three-step setup. Launch probes are read-only; changes require
/// an explicit method choice and confirmation on this screen.
class EnvironmentSetupScreen extends StatefulWidget {
  final AppNotifier notifier;

  const EnvironmentSetupScreen({super.key, required this.notifier});

  @override
  State<EnvironmentSetupScreen> createState() => _EnvironmentSetupScreenState();
}

class _EnvironmentSetupScreenState extends State<EnvironmentSetupScreen> {
  String? _copied;

  Future<void> _copy(String value) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    setState(() => _copied = value);
    Future<void>.delayed(const Duration(milliseconds: 1400), () {
      if (mounted && _copied == value) setState(() => _copied = null);
    });
  }

  int _stage(EnvironmentSetupPhase phase) => switch (phase) {
    EnvironmentSetupPhase.preflight => 0,
    EnvironmentSetupPhase.review => 1,
    _ => 2,
  };

  @override
  Widget build(BuildContext context) {
    final state = widget.notifier.environmentReadiness;
    return Scaffold(
      backgroundColor: AppColors.background,
      body: LayoutBuilder(
        builder: (context, constraints) => Row(
          children: [
            if (constraints.maxWidth >= 820)
              SizedBox(width: 260, child: _Rail(stage: _stage(state.phase))),
            Expanded(
              child: Column(
                children: [
                  Expanded(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(44, 38, 44, 28),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 780),
                        child: _body(state),
                      ),
                    ),
                  ),
                  _footer(state),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(EnvironmentReadiness state) => switch (state.phase) {
    EnvironmentSetupPhase.preflight => _preflight(state),
    EnvironmentSetupPhase.review => _review(state),
    EnvironmentSetupPhase.chooseMethod => _choose(state),
    EnvironmentSetupPhase.installing ||
    EnvironmentSetupPhase.waitingForTerminal ||
    EnvironmentSetupPhase.verifying => _installing(state),
    EnvironmentSetupPhase.failed => _failure(state),
    EnvironmentSetupPhase.ready => _ready(state),
  };

  Widget _heading(String eyebrow, String title, String lead) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        eyebrow.toUpperCase(),
        style: TextStyle(
          color: AppColors.accent,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 1.4,
        ),
      ),
      const SizedBox(height: 10),
      Text(
        title,
        style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w600),
      ),
      const SizedBox(height: 12),
      Text(lead, style: TextStyle(color: AppColors.textSoft, height: 1.55)),
      const SizedBox(height: 26),
    ],
  );

  Widget _preflight(EnvironmentReadiness state) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _heading(
        'Step 1 of 3 · Pre-flight check',
        'Checking this computer',
        'This check is read-only. Harness verifies every tool it needs before proposing any changes.',
      ),
      _notice(
        Icons.lock_outline,
        'Nothing is being installed',
        'No files, packages or system settings change during this check.',
      ),
      const SizedBox(height: 18),
      _checkList(state, checking: true),
    ],
  );

  Widget _review(EnvironmentReadiness state) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _heading(
        'Step 2 of 3 · Review setup',
        'Here is exactly what is required',
        'Ready items stay untouched. Only missing items continue to setup.',
      ),
      _checkList(state),
    ],
  );

  Widget _choose(EnvironmentReadiness state) {
    final mode = state.mode ?? EnvironmentSetupMode.automatic;
    final items = _installItems(state);
    final count = items.length;
    final countLabel =
        '$count missing ${count == 1 ? 'dependency' : 'dependencies'}';
    final needsTerminal = items.any((item) => item.requiresTerminal);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _heading(
          'Step 3 of 3 · Choose & install',
          'Choose how to prepare this computer',
          count == 0
              ? 'Nothing is left to install. Harness will run one final verification.'
              : 'Only the $countLabel below will be installed. Ready items stay untouched.',
        ),
        SegmentedButton<EnvironmentSetupMode>(
          segments: const [
            ButtonSegment(
              value: EnvironmentSetupMode.automatic,
              icon: Icon(Icons.auto_fix_high, size: 17),
              label: Text('Automatic'),
            ),
            ButtonSegment(
              value: EnvironmentSetupMode.manual,
              icon: Icon(Icons.terminal, size: 17),
              label: Text('Manual'),
            ),
          ],
          selected: {mode},
          onSelectionChanged: (value) =>
              widget.notifier.selectEnvironmentSetupMode(value.first),
        ),
        const SizedBox(height: 18),
        if (mode == EnvironmentSetupMode.automatic) ...[
          if (needsTerminal) ...[
            _notice(
              Icons.terminal,
              'Admin prompts stay in Terminal',
              'Harness opens one operating system Terminal for the missing host dependencies. Your password is entered there and is never read or stored by this app.',
              warning: true,
            ),
            const SizedBox(height: 16),
          ],
          _planList(items),
        ] else
          _manualList(items),
        const SizedBox(height: 14),
        _verificationHint(),
      ],
    );
  }

  Widget _installing(EnvironmentReadiness state) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _heading(
        'Step 3 of 3 · Installation',
        state.phase == EnvironmentSetupPhase.waitingForTerminal
            ? 'Finish the secure Terminal step'
            : state.phase == EnvironmentSetupPhase.verifying
            ? 'Running final verification'
            : 'Preparing this computer',
        state.message ?? 'Installing only the missing required tools.',
      ),
      if (state.phase == EnvironmentSetupPhase.waitingForTerminal)
        _notice(
          Icons.lock_outline,
          'Harness cannot see your password',
          'Complete the visible prompts in Terminal. This screen checks again automatically every 5 seconds.',
          warning: true,
        ),
      const SizedBox(height: 18),
      _checkList(state, checking: true),
      _logs(state),
    ],
  );

  Widget _failure(EnvironmentReadiness state) {
    final failure = state.failure;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _heading(
          'Setup needs attention',
          failure?.title ?? 'Environment setup failed',
          failure?.detail ?? state.message ?? 'Review the full error below.',
        ),
        _notice(
          Icons.error_outline,
          'The app stopped safely',
          'Nothing after the failed required step was started. Retry or switch to Manual.',
          error: true,
        ),
        const SizedBox(height: 16),
        _checkList(state),
        if (failure?.command != null) ...[
          const SizedBox(height: 16),
          CommandRow(
            command: failure!.command!,
            copied: _copied == failure.command,
            onCopy: () => _copy(failure.command!),
          ),
        ],
        _logs(state),
      ],
    );
  }

  Widget _ready(EnvironmentReadiness state) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _heading(
        'Setup complete',
        'This computer is ready',
        'Every required command passed. Continue to Harness sign-in.',
      ),
      _checkList(state),
      const SizedBox(height: 18),
      _notice(
        Icons.check_circle_outline,
        'Verified, not assumed',
        'Harness repeats this quick read-only check whenever the desktop app starts.',
      ),
    ],
  );

  Widget _checkList(EnvironmentReadiness state, {bool checking = false}) =>
      _Panel(
        child: Column(
          children: [
            const _CheckSectionLabel('Host dependencies'),
            _CheckRow(
              label: 'System tools & writable home',
              detail: Platform.isMacOS
                  ? 'Shell, curl, tar, sed, awk, shasum · Xcode or Command Line Tools'
                  : 'Shell, curl, tar, sed, awk, sha256sum · writable home',
              status: _systemStatus(state),
              checking:
                  checking && state.phase == EnvironmentSetupPhase.preflight,
            ),
            _CheckRow(
              label: Platform.isMacOS
                  ? 'Homebrew & tmux terminal backend'
                  : 'tmux terminal backend',
              detail: 'Required for every terminal session',
              status: state.steps[EnvironmentStep.tmux],
            ),
            if (Platform.isLinux)
              _CheckRow(
                label: 'Native image clipboard',
                detail: _linuxClipboardDetail,
                status: state.steps[EnvironmentStep.clipboard],
              ),
            const _CheckSectionLabel('Harness components'),
            _CheckRow(
              label: 'Managed Node 20+ & Harness CLI',
              detail: '~/.harness/runtime · harness version',
              status: state.steps[EnvironmentStep.harness],
            ),
          ],
        ),
      );

  EnvironmentStepStatus? _systemStatus(EnvironmentReadiness state) {
    if (state.systemReady) return EnvironmentStepStatus.ready;
    if (state.phase == EnvironmentSetupPhase.preflight) return null;
    if (state.phase == EnvironmentSetupPhase.waitingForTerminal &&
        state.terminalSetup == EnvironmentTerminalSetup.linuxHost) {
      return EnvironmentStepStatus.needsTerminal;
    }
    if (state.phase == EnvironmentSetupPhase.installing) {
      return EnvironmentStepStatus.running;
    }
    return EnvironmentStepStatus.failed;
  }

  String? get _linuxClipboardPackage {
    if ((Platform.environment['WAYLAND_DISPLAY'] ?? '').isNotEmpty) {
      return 'wl-clipboard';
    }
    if ((Platform.environment['DISPLAY'] ?? '').isNotEmpty) return 'xclip';
    return null;
  }

  String get _linuxClipboardDetail => switch (_linuxClipboardPackage) {
    'wl-clipboard' => 'wl-copy · provided by wl-clipboard',
    'xclip' => 'xclip · required for native image paste',
    _ => 'Not applicable · image paste uses file-path fallback',
  };

  bool _needsInstall(EnvironmentStepStatus? status) =>
      status != EnvironmentStepStatus.ready &&
      status != EnvironmentStepStatus.notApplicable;

  List<_InstallItem> _installItems(EnvironmentReadiness state) {
    final items = <_InstallItem>[];
    final tmuxStatusMissing = _needsInstall(state.steps[EnvironmentStep.tmux]);
    final tmuxMissing =
        state.tmuxBinaryReady == false ||
        (state.tmuxBinaryReady == null && tmuxStatusMissing);

    if (Platform.isMacOS) {
      if (!state.systemReady) {
        items.add(
          const _InstallItem(
            title: 'Apple developer tools',
            detail: 'Xcode or Command Line Tools',
            command: '/usr/bin/xcrun --find clang || { if [ -x /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild ]; then sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer; else xcode-select --install; fi; }',
            requiresTerminal: true,
          ),
        );
      }
      final homebrewMissing =
          state.homebrewReady == false ||
          (state.homebrewReady == null && tmuxStatusMissing);
      if (homebrewMissing) {
        items.add(
          const _InstallItem(
            title: 'Homebrew',
            detail: 'Required package manager for tmux',
            command: '/bin/bash -c "\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
            requiresTerminal: true,
          ),
        );
      }
      if (tmuxMissing) {
        items.add(
          const _InstallItem(
            title: 'tmux',
            detail: 'Required for every terminal session',
            command: 'eval "\$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)" && brew install tmux',
          ),
        );
      }
    } else if (Platform.isLinux) {
      final packages = <String>{...state.missingLinuxPackages};
      if (!state.systemReady && packages.isEmpty) {
        packages.addAll(const [
          'bash',
          'curl',
          'tar',
          'sed',
          'gawk',
          'coreutils',
        ]);
      }
      if (_needsInstall(state.steps[EnvironmentStep.clipboard]) &&
          _linuxClipboardPackage != null) {
        packages.add(_linuxClipboardPackage!);
      }
      if (tmuxMissing) packages.add('tmux');
      if (packages.isNotEmpty) {
        final names = packages.join(', ');
        items.add(
          _InstallItem(
            title: 'Linux host dependencies',
            detail: '$names · one apt transaction',
            command: 'sudo apt-get install -y ${packages.join(' ')}',
            requiresTerminal: true,
          ),
        );
      }
    }

    if (_needsInstall(state.steps[EnvironmentStep.harness])) {
      items.add(
        const _InstallItem(
          title: 'Managed Node 20+ & Harness CLI',
          detail: '~/.harness only',
          command: kHarnessDesktopInstallCommand,
        ),
      );
    }
    return items;
  }

  Widget _planList(List<_InstallItem> items) {
    if (items.isEmpty) {
      return _notice(
        Icons.check_circle_outline,
        'Nothing left to install',
        'Every dependency is ready. Continue to final verification.',
      );
    }
    return _Panel(
      child: Column(
        children: [
          for (var index = 0; index < items.length; index++)
            ListTile(
              leading: CircleAvatar(
                radius: 14,
                backgroundColor: AppColors.hover,
                child: Text(
                  '${index + 1}',
                  style: const TextStyle(fontSize: 11),
                ),
              ),
              title: Text(
                items[index].title,
                style: const TextStyle(fontSize: 13),
              ),
              trailing: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 280),
                child: Text(
                  items[index].detail,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.end,
                  style: TextStyle(color: AppColors.muted, fontSize: 11),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _manualList(List<_InstallItem> items) => Column(
    children: [
      if (items.isEmpty)
        _notice(
          Icons.check_circle_outline,
          'Nothing left to install',
          'Every dependency is ready. Continue to final verification.',
        ),
      for (var index = 0; index < items.length; index++)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: _Panel(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${index + 1} · ${items[index].title}',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 9),
                CommandRow(
                  command: items[index].command,
                  copied: _copied == items[index].command,
                  onCopy: () => _copy(items[index].command),
                ),
              ],
            ),
          ),
        ),
    ],
  );

  Widget _verificationHint() => Row(
    children: [
      Icon(Icons.verified_outlined, size: 16, color: AppColors.success),
      const SizedBox(width: 8),
      Expanded(
        child: Text(
          'After installation, Harness verifies every required command.',
          style: TextStyle(color: AppColors.textSoft, fontSize: 11),
        ),
      ),
    ],
  );

  Widget _logs(EnvironmentReadiness state) {
    if (state.output.isEmpty) return const SizedBox.shrink();
    final diagnostics = state.output.join('\n');
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 18),
      decoration: BoxDecoration(
        color: AppColors.background,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(
              children: [
                const Text(
                  'Live logs',
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                ),
                const Spacer(),
                TextButton.icon(
                  onPressed: () => _copy(diagnostics),
                  icon: const Icon(Icons.copy, size: 14),
                  label: Text(
                    _copied == diagnostics ? 'Copied' : 'Copy diagnostics',
                  ),
                ),
              ],
            ),
          ),
          Divider(height: 1, color: AppColors.border),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 210),
            child: SingleChildScrollView(
              reverse: true,
              padding: const EdgeInsets.all(14),
              child: SelectableText(
                diagnostics,
                style: TextStyle(
                  fontFamily: AppFonts.mono,
                  fontSize: 11,
                  height: 1.55,
                  color: AppColors.textSoft,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _notice(
    IconData icon,
    String title,
    String detail, {
    bool warning = false,
    bool error = false,
  }) {
    final tone = error
        ? AppColors.danger
        : warning
        ? AppColors.warning
        : AppColors.accent;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.07),
        border: Border.all(color: tone.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: tone),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  detail,
                  style: TextStyle(
                    color: AppColors.textSoft,
                    fontSize: 12,
                    height: 1.45,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _footer(EnvironmentReadiness state) {
    final busy = widget.notifier.environmentSetupInFlight;
    final mode = state.mode ?? EnvironmentSetupMode.automatic;
    final missingCount = _installItems(state).length;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 36, vertical: 16),
      decoration: BoxDecoration(
        color: AppColors.sidebar,
        border: Border(top: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              'No password is collected by Harness.',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: AppColors.muted, fontSize: 11),
            ),
          ),
          const SizedBox(width: 12),
          if (state.phase == EnvironmentSetupPhase.review)
            FilledButton(
              onPressed: widget.notifier.showEnvironmentMethodChoice,
              child: const Text('Continue'),
            )
          else if (state.phase == EnvironmentSetupPhase.chooseMethod) ...[
            TextButton(
              onPressed: widget.notifier.showEnvironmentReview,
              child: const Text('Back'),
            ),
            const SizedBox(width: 8),
            FilledButton.icon(
              onPressed: busy
                  ? null
                  : mode == EnvironmentSetupMode.automatic
                  ? widget.notifier.startEnvironmentSetup
                  : widget.notifier.retryEnvironmentSetup,
              icon: Icon(
                mode == EnvironmentSetupMode.automatic
                    ? Icons.play_arrow
                    : Icons.refresh,
                size: 16,
              ),
              label: Text(
                mode == EnvironmentSetupMode.automatic
                    ? missingCount == 0
                          ? 'Verify and continue'
                          : 'Install $missingCount ${missingCount == 1 ? 'tool' : 'tools'}'
                    : 'I ran these · Recheck',
              ),
            ),
          ] else if (state.phase == EnvironmentSetupPhase.ready)
            FilledButton(
              onPressed: widget.notifier.continueAfterEnvironmentSetup,
              child: const Text('Continue to sign in'),
            )
          else if (state.phase == EnvironmentSetupPhase.failed) ...[
            TextButton(
              onPressed: () {
                widget.notifier.selectEnvironmentSetupMode(
                  EnvironmentSetupMode.manual,
                );
                widget.notifier.showEnvironmentMethodChoice();
              },
              child: const Text('Switch to Manual'),
            ),
            const SizedBox(width: 8),
            FilledButton(
              onPressed: busy ? null : widget.notifier.startEnvironmentSetup,
              child: const Text('Retry'),
            ),
          ] else if (state.phase == EnvironmentSetupPhase.waitingForTerminal)
            OutlinedButton.icon(
              onPressed: busy
                  ? null
                  : () => widget.notifier.recheckEnvironmentStep(
                      state.steps[EnvironmentStep.clipboard] ==
                              EnvironmentStepStatus.needsTerminal
                          ? EnvironmentStep.clipboard
                          : EnvironmentStep.tmux,
                    ),
              icon: const Icon(Icons.refresh, size: 16),
              label: const Text('Recheck now'),
            )
          else if (busy)
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
        ],
      ),
    );
  }
}

class _InstallItem {
  final String title;
  final String detail;
  final String command;
  final bool requiresTerminal;

  const _InstallItem({
    required this.title,
    required this.detail,
    required this.command,
    this.requiresTerminal = false,
  });
}

class _Rail extends StatelessWidget {
  final int stage;
  const _Rail({required this.stage});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(25, 36, 25, 24),
    decoration: BoxDecoration(
      color: AppColors.sidebar,
      border: Border(right: BorderSide(color: AppColors.border)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'ENVIRONMENT SETUP',
          style: TextStyle(
            color: AppColors.muted,
            fontSize: 10,
            fontWeight: FontWeight.w700,
            letterSpacing: 1.3,
          ),
        ),
        const SizedBox(height: 8),
        const Text(
          'Prepare Harness\nfor this computer',
          style: TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.w600,
            height: 1.25,
          ),
        ),
        const SizedBox(height: 30),
        for (var index = 0; index < 3; index++)
          _RailStep(index: index, stage: stage),
        const Spacer(),
        Text(
          'Required: tmux · managed Node 20+ · Harness CLI',
          style: TextStyle(color: AppColors.muted, fontSize: 11, height: 1.5),
        ),
      ],
    ),
  );
}

class _RailStep extends StatelessWidget {
  final int index;
  final int stage;
  const _RailStep({required this.index, required this.stage});

  @override
  Widget build(BuildContext context) {
    const labels = [
      ('Pre-flight check', 'Read-only inspection'),
      ('Review setup', 'See every change'),
      ('Choose & install', 'Automatic or manual'),
    ];
    final done = index < stage;
    final active = index == stage;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: active ? AppColors.selected : Colors.transparent,
        borderRadius: BorderRadius.circular(9),
      ),
      child: Row(
        children: [
          Container(
            width: 28,
            height: 28,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: active ? AppColors.accent : AppColors.surface,
              border: Border.all(color: AppColors.borderStrong),
            ),
            child: done
                ? Icon(Icons.check, size: 14, color: AppColors.success)
                : Text(
                    '${index + 1}',
                    style: TextStyle(
                      fontSize: 11,
                      color: active ? Colors.white : AppColors.textSoft,
                    ),
                  ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  labels[index].$1,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: active ? AppColors.text : AppColors.textSoft,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  labels[index].$2,
                  style: TextStyle(fontSize: 10, color: AppColors.muted),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Panel extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  const _Panel({required this.child, this.padding = EdgeInsets.zero});

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: padding,
    clipBehavior: Clip.antiAlias,
    decoration: BoxDecoration(
      color: AppColors.surface,
      border: Border.all(color: AppColors.border),
      borderRadius: BorderRadius.circular(11),
    ),
    child: child,
  );
}

class _CheckSectionLabel extends StatelessWidget {
  final String label;
  const _CheckSectionLabel(this.label);

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.fromLTRB(16, 11, 16, 8),
    decoration: BoxDecoration(
      color: AppColors.background.withValues(alpha: 0.28),
      border: Border(bottom: BorderSide(color: AppColors.border)),
    ),
    child: Text(
      label.toUpperCase(),
      style: TextStyle(
        color: AppColors.textSoft,
        fontSize: 10,
        fontWeight: FontWeight.w700,
        letterSpacing: 1.1,
      ),
    ),
  );
}

class _CheckRow extends StatelessWidget {
  final String label;
  final String detail;
  final EnvironmentStepStatus? status;
  final bool checking;
  const _CheckRow({
    required this.label,
    required this.detail,
    required this.status,
    this.checking = false,
  });

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      EnvironmentStepStatus.ready => AppColors.success,
      EnvironmentStepStatus.failed => AppColors.danger,
      EnvironmentStepStatus.needsTerminal => AppColors.warning,
      EnvironmentStepStatus.running => AppColors.accent,
      EnvironmentStepStatus.notApplicable => AppColors.muted,
      _ => AppColors.muted,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        children: [
          if (checking || status == EnvironmentStepStatus.running)
            SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2, color: color),
            )
          else
            Icon(
              status == EnvironmentStepStatus.ready
                  ? Icons.check_circle
                  : status == EnvironmentStepStatus.failed
                  ? Icons.cancel_outlined
                  : status == EnvironmentStepStatus.notApplicable
                  ? Icons.remove_circle_outline
                  : Icons.circle_outlined,
              size: 17,
              color: color,
            ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  detail,
                  style: TextStyle(color: AppColors.muted, fontSize: 11),
                ),
              ],
            ),
          ),
          Text(switch (status) {
            EnvironmentStepStatus.ready => 'Ready',
            EnvironmentStepStatus.failed => 'Missing',
            EnvironmentStepStatus.needsTerminal => 'Terminal',
            EnvironmentStepStatus.running => 'Working',
            EnvironmentStepStatus.notApplicable => 'Not applicable',
            _ => checking ? 'Checking' : 'Required',
          }, style: TextStyle(color: color, fontSize: 11)),
        ],
      ),
    );
  }
}
