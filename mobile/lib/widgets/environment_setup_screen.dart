import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../bootstrap/environment_provisioner.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/command_row.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';

/// One setup review with a direct install action. Launch probes stay read-only;
/// installation starts only after the user chooses the visible install action.
class EnvironmentSetupScreen extends StatefulWidget {
  final AppNotifier notifier;

  const EnvironmentSetupScreen({super.key, required this.notifier});

  @override
  State<EnvironmentSetupScreen> createState() => _EnvironmentSetupScreenState();
}

class _EnvironmentSetupScreenState extends State<EnvironmentSetupScreen> {
  String? _copied;
  final _scroll = ScrollController();
  final _primaryFocus = FocusNode(debugLabel: 'Setup action');
  final _bodyFocus = FocusNode(
    debugLabel: 'Setup details',
    skipTraversal: true,
  );
  final _manualFocus = FocusNode(debugLabel: 'Switch setup method');
  EnvironmentSetupPhase? _lastPhase;
  bool _actionWasAvailable = false;
  bool _detailsOpen = false;

  @override
  void dispose() {
    _scroll.dispose();
    _primaryFocus.dispose();
    _bodyFocus.dispose();
    _manualFocus.dispose();
    super.dispose();
  }

  Future<void> _copy(String value) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    setState(() => _copied = value);
    Future<void>.delayed(const Duration(milliseconds: 1400), () {
      if (mounted && _copied == value) setState(() => _copied = null);
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final state = widget.notifier.environmentReadiness;
    final phaseChanged = _lastPhase != state.phase;
    final actionAvailable =
        !widget.notifier.environmentSetupInFlight &&
        const {
          EnvironmentSetupPhase.review,
          EnvironmentSetupPhase.chooseMethod,
          EnvironmentSetupPhase.failed,
          EnvironmentSetupPhase.waitingForTerminal,
          EnvironmentSetupPhase.ready,
        }.contains(state.phase);
    if (phaseChanged || (actionAvailable && !_actionWasAvailable)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || ModalRoute.of(context)?.isCurrent == false) return;
        if (widget.notifier.environmentReadiness.phase != state.phase) return;
        if (phaseChanged && _scroll.hasClients) _scroll.jumpTo(0);
        // A new next step should be usable with Enter. Keep an explicit choice
        // to read/copy details or change methods when asynchronous updates land.
        if (actionAvailable &&
            !widget.notifier.environmentSetupInFlight &&
            !_bodyFocus.hasFocus &&
            !_manualFocus.hasFocus) {
          _primaryFocus.requestFocus();
        }
      });
    }
    _lastPhase = state.phase;
    _actionWasAvailable = actionAvailable;
    final compact = MediaQuery.sizeOf(context).height < 640;
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Padding(
          padding: EdgeInsets.all(compact ? 16 : 24),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: Material(
                color: AppColors.sidebar,
                clipBehavior: Clip.antiAlias,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                  side: BorderSide(color: AppColors.border),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Flexible(
                      child: SingleChildScrollView(
                        controller: _scroll,
                        padding: EdgeInsets.all(compact ? 20 : 28),
                        child: Focus(
                          focusNode: _bodyFocus,
                          child: _body(state),
                        ),
                      ),
                    ),
                    _footer(state),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _body(EnvironmentReadiness state) => switch (state.phase) {
    EnvironmentSetupPhase.preflight => _preflight(state),
    EnvironmentSetupPhase.review ||
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
      const SizedBox(height: 6),
      Text(
        title,
        style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w600),
      ),
      const SizedBox(height: 8),
      Text(lead, style: TextStyle(color: AppColors.textSoft, height: 1.55)),
      const SizedBox(height: 16),
    ],
  );

  Widget _preflight(EnvironmentReadiness state) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _heading(
        'Getting started',
        'Checking this computer',
        'Checking the tools OpenHarness needs to run your harnesses.',
      ),
      _checkList(state, checking: true),
    ],
  );

  Widget _choose(EnvironmentReadiness state) {
    final mode = state.mode ?? EnvironmentSetupMode.automatic;
    final items = _installItems(state);
    final count = items.length;
    final countLabel = '$count ${count == 1 ? 'tool' : 'tools'}';
    final needsTerminal = items.any((item) => item.requiresTerminal);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _heading(
          'Getting started',
          'Get this computer ready',
          count == 0
              ? 'Your tools are ready. Verify them to continue.'
              : count == 1
              ? 'Install this tool, then sign in to start your first harness.'
              : 'Install these $countLabel, then sign in to start your first harness.',
        ),
        Row(
          children: [
            const Expanded(
              child: Text(
                'Required tools',
                style: TextStyle(fontWeight: FontWeight.w500),
              ),
            ),
            TextButton(
              style: TextButton.styleFrom(foregroundColor: AppColors.textSoft),
              onPressed: () => widget.notifier.selectEnvironmentSetupMode(
                mode == EnvironmentSetupMode.automatic
                    ? EnvironmentSetupMode.manual
                    : EnvironmentSetupMode.automatic,
              ),
              child: Text(
                mode == EnvironmentSetupMode.automatic
                    ? 'Manual setup'
                    : 'Use automatic setup',
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (mode == EnvironmentSetupMode.automatic) ...[
          if (needsTerminal) ...[
            _notice(
              Icons.terminal,
              'Admin prompts stay in Terminal',
              'Complete any installation prompts there, then return to OpenHarness.',
            ),
            const SizedBox(height: 16),
          ],
          _planList(items),
        ] else
          _manualList(items),
      ],
    );
  }

  Widget _installing(EnvironmentReadiness state) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _heading(
        'Getting started',
        state.phase == EnvironmentSetupPhase.waitingForTerminal
            ? 'Finish setup in Terminal'
            : state.phase == EnvironmentSetupPhase.verifying
            ? 'Running final verification'
            : 'Preparing this computer',
        state.message ?? 'Installing only the missing required tools.',
      ),
      if (state.phase == EnvironmentSetupPhase.waitingForTerminal)
        _notice(
          Icons.lock_outline,
          'OpenHarness cannot see your password',
          'Finish the prompts in Terminal, then return here. OpenHarness checks progress automatically.',
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
        'Every required command passed. Continue to OpenHarness sign-in.',
      ),
      _checkList(state),
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
            const _CheckSectionLabel('OpenHarness components'),
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
    final stacked = MediaQuery.textScalerOf(context).scale(1) > 1.25;
    return _Panel(
      child: Column(
        children: [
          for (var index = 0; index < items.length; index++)
            ListTile(
              dense: true,
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
              subtitle: stacked
                  ? Text(
                      items[index].detail,
                      style: TextStyle(color: AppColors.textSoft, fontSize: 11),
                    )
                  : null,
              trailing: stacked
                  ? null
                  : ConstrainedBox(
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
      child: ExpansionTile(
        initiallyExpanded: _detailsOpen,
        maintainState: true,
        expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
        expansionAnimationStyle: AnimationStyle.noAnimation,
        onExpansionChanged: (open) => setState(() => _detailsOpen = open),
        title: Row(
          children: [
            const Expanded(
              child: Text(
                'Setup details',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
              ),
            ),
            TextButton.icon(
              onPressed: () => _copy(diagnostics),
              icon: const Icon(Icons.copy, size: 14),
              label: Text(
                _copied == diagnostics ? 'Copied' : 'Copy diagnostics',
              ),
            ),
          ],
        ),
        children: [
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

  Widget _notice(IconData icon, String title, String detail) {
    final tone = AppColors.accent;
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
    final manual = mode == EnvironmentSetupMode.manual;
    String? label;
    VoidCallback? action;
    IconData? icon;
    switch (state.phase) {
      case EnvironmentSetupPhase.review || EnvironmentSetupPhase.chooseMethod:
        label = manual
            ? 'Check again'
            : missingCount == 0
            ? 'Verify and continue'
            : 'Install $missingCount ${missingCount == 1 ? 'tool' : 'tools'}';
        icon = manual ? Icons.refresh : Icons.download_outlined;
        action = manual
            ? widget.notifier.retryEnvironmentSetup
            : widget.notifier.startEnvironmentSetup;
      case EnvironmentSetupPhase.failed:
        label = 'Retry';
        action = manual
            ? widget.notifier.retryEnvironmentSetup
            : widget.notifier.startEnvironmentSetup;
      case EnvironmentSetupPhase.ready:
        label = 'Continue to sign in';
        action = widget.notifier.continueAfterEnvironmentSetup;
      case EnvironmentSetupPhase.waitingForTerminal:
        label = 'Recheck now';
        icon = Icons.refresh;
        action = () => widget.notifier.recheckEnvironmentStep(
          state.steps[EnvironmentStep.clipboard] ==
                  EnvironmentStepStatus.needsTerminal
              ? EnvironmentStep.clipboard
              : EnvironmentStep.tmux,
        );
      default:
        break;
    }
    final actions = Wrap(
      alignment: WrapAlignment.end,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 8,
      runSpacing: 8,
      children: [
        if (state.phase == EnvironmentSetupPhase.failed && !manual)
          TextButton(
            focusNode: _manualFocus,
            onPressed: busy
                ? null
                : () {
                    widget.notifier.selectEnvironmentSetupMode(
                      EnvironmentSetupMode.manual,
                    );
                    widget.notifier.showEnvironmentMethodChoice();
                  },
            child: const Text('Switch to Manual'),
          ),
        if (label != null)
          FilledButton.icon(
            focusNode: _primaryFocus,
            autofocus: true,
            onPressed: busy ? null : action,
            icon: icon == null ? null : Icon(icon, size: 16),
            label: Text(label),
          )
        else if (busy)
          const SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
      ],
    );
    final next = Text(
      'Next: sign in and start a harness.',
      style: TextStyle(color: AppColors.textSoft, fontSize: 11),
    );
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
      decoration: BoxDecoration(
        color: AppColors.sidebar,
        border: Border(top: BorderSide(color: AppColors.border)),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          if (constraints.maxWidth < 600 ||
              MediaQuery.textScalerOf(context).scale(1) > 1.25) {
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [next, const SizedBox(height: 12), actions],
            );
          }
          return Row(
            children: [
              Expanded(child: next),
              const SizedBox(width: 12),
              actions,
            ],
          );
        },
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
