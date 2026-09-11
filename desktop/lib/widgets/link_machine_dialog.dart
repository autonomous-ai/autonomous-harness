import 'dart:async';

import 'package:flutter/material.dart';

import '../auth/cli_link.dart';
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../shared/widgets/skeleton.dart';
import '../theme/app_theme.dart';

/// Sets (or manages) THIS machine's remote password, so another machine can later connect to it
/// with `harness link connect` — no code to copy/paste. To link a specific machine FROM here
/// instead, select it in the sidebar (see `machine_rail.dart`'s `selectMachineForSetup`), not
/// duplicated here — that flow lives in `link_machine_screen.dart`.
Future<void> showLinkMachineDialog(BuildContext context, AppNotifier notifier) {
  return showAppDialog<void>(
    context: context,
    builder: (context) => _LinkMachineDialog(notifier: notifier),
  );
}

class _LinkMachineDialog extends StatefulWidget {
  final AppNotifier notifier;

  const _LinkMachineDialog({required this.notifier});

  @override
  State<_LinkMachineDialog> createState() => _LinkMachineDialogState();
}

class _LinkMachineDialogState extends State<_LinkMachineDialog> {
  bool _statusLoading = true;
  RemotePasswordStatus? _status;
  String? _statusError;

  // Set/change form state.
  bool _editing = false;
  final _passwordController = TextEditingController();
  final _confirmController = TextEditingController();
  bool _obscure = true;
  bool _submitting = false;
  String? _formError;

  bool _clearing = false;

  @override
  void initState() {
    super.initState();
    unawaited(widget.notifier.refreshLinkedMachines());
    unawaited(_loadStatus());
  }

  @override
  void dispose() {
    _passwordController.dispose();
    _confirmController.dispose();
    super.dispose();
  }

  Future<void> _loadStatus() async {
    setState(() {
      _statusLoading = true;
      _statusError = null;
    });
    final status = await widget.notifier.remotePasswordStatus();
    if (!mounted) return;
    setState(() {
      _statusLoading = false;
      if (status.error != null) {
        _statusError = status.error;
      } else {
        _status = status;
        _editing = !status.hasPassword;
      }
    });
  }

  Future<void> _submit() async {
    final password = _passwordController.text;
    final confirm = _confirmController.text;
    if (password.isEmpty) {
      setState(() => _formError = 'Enter a password');
      return;
    }
    if (password != confirm) {
      setState(() => _formError = 'Passwords do not match');
      return;
    }
    setState(() {
      _submitting = true;
      _formError = null;
    });
    final result = await widget.notifier.setRemotePassword(password);
    if (!mounted) return;
    setState(() {
      _submitting = false;
      if (result.error != null) {
        _formError = result.error;
      } else {
        _editing = false;
        _status = RemotePasswordStatus(
          hasPassword: true,
          fingerprint: result.fingerprint,
          setAt: DateTime.now(),
        );
        _passwordController.clear();
        _confirmController.clear();
      }
    });
  }

  Future<void> _confirmClear() async {
    final confirmed = await showAppDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Clear remote password'),
        content: SizedBox(
          width: 360,
          child: Text(
            'Clear the remote password for this machine? Anyone using it to connect will lose '
            "remote access until you set a new one. This can't be undone.",
            style: TextStyle(fontFamily: AppFonts.sans, fontSize: 13.5),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('remote-password-clear-confirm-button'),
            style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Clear'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _clearing = true);
    final error = await widget.notifier.clearRemotePassword();
    if (!mounted) return;
    setState(() {
      _clearing = false;
      if (error != null) {
        _statusError = error;
      } else {
        _status = const RemotePasswordStatus(hasPassword: false);
        _editing = true;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Link another machine'),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                "Set a remote password here so another machine can connect to this one. To link "
                "a specific machine from here instead, select it in the sidebar — you'll get a "
                "\"Link this machine\" guide to enter the password there.",
                style: TextStyle(
                  fontFamily: AppFonts.sans,
                  fontFamilyFallback: AppFonts.sansFallback,
                  fontSize: 11.2,
                  color: AppColors.mutedStrong,
                  height: 1.4,
                ),
              ),
              const SizedBox(height: 16),
              _ActionCard(
                icon: Icons.password,
                title: 'Let another machine control this one',
                steps: const [
                  'Set a remote password for this machine below.',
                  "On the OTHER machine, select this machine in the sidebar (it'll show "
                      "'link required') and enter the same password there.",
                ],
                error: _formError ?? _statusError,
                child: _buildPasswordSection(),
              ),
              const SizedBox(height: 18),
              Text(
                'MACHINES YOU CAN REMOTE INTO',
                style: TextStyle(
                  fontFamily: AppFonts.sans,
                  fontFamilyFallback: AppFonts.sansFallback,
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.6,
                  color: AppColors.mutedStrong,
                ),
              ),
              const SizedBox(height: 8),
              ListenableBuilder(
                listenable: widget.notifier,
                builder: (context, _) {
                  if (widget.notifier.linkedMachinesLoading &&
                      widget.notifier.linkedMachines.isEmpty) {
                    return const _LinkedMachinesSkeleton(
                      key: Key('linked-machines-skeleton'),
                    );
                  }
                  final machines = widget.notifier.linkedMachines;
                  if (machines.isEmpty) {
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Text(
                        'No machines linked yet.',
                        style: TextStyle(
                          fontFamily: AppFonts.sans,
                          fontFamilyFallback: AppFonts.sansFallback,
                          fontSize: 12,
                          color: AppColors.muted,
                        ),
                      ),
                    );
                  }
                  return Column(
                    children: [
                      for (final machine in machines)
                        _LinkedMachineRow(
                          machine: machine,
                          displayName: widget.notifier
                              .stateOf(machine.machineId)
                              ?.machine
                              .displayName,
                          onUnlink: () async {
                            await widget.notifier.unlinkMachine(
                              machine.machineId,
                            );
                          },
                        ),
                    ],
                  );
                },
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Close'),
        ),
      ],
    );
  }

  Widget _buildPasswordSection() {
    if (_statusLoading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: SizedBox(
          width: 16,
          height: 16,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    final status = _status;
    if (!_editing && status != null && status.hasPassword) {
      return _RemotePasswordSummary(
        status: status,
        clearing: _clearing,
        onChange: () => setState(() {
          _editing = true;
          _formError = null;
        }),
        onClear: _confirmClear,
      );
    }
    return _RemotePasswordForm(
      passwordController: _passwordController,
      confirmController: _confirmController,
      obscure: _obscure,
      onToggleObscure: () => setState(() => _obscure = !_obscure),
      submitting: _submitting,
      onSubmit: _submit,
      onCancel: (status != null && status.hasPassword)
          ? () => setState(() {
              _editing = false;
              _formError = null;
              _passwordController.clear();
              _confirmController.clear();
            })
          : null,
    );
  }
}

class _ActionCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final List<String> steps;
  final Widget child;
  final String? error;

  const _ActionCard({
    required this.icon,
    required this.title,
    required this.steps,
    required this.child,
    this.error,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.hover,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 18, color: AppColors.accent),
          const SizedBox(height: 8),
          Text(
            title,
            style: TextStyle(
              fontFamily: AppFonts.sans,
              fontFamilyFallback: AppFonts.sansFallback,
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: AppColors.text,
            ),
          ),
          const SizedBox(height: 10),
          for (var i = 0; i < steps.length; i++) ...[
            if (i > 0) const SizedBox(height: 8),
            _ActionStep(number: i + 1, text: steps[i]),
          ],
          const SizedBox(height: 12),
          child,
          if (error != null) ...[
            const SizedBox(height: 8),
            Text(
              error!,
              style: TextStyle(
                fontFamily: AppFonts.sans,
                fontFamilyFallback: AppFonts.sansFallback,
                fontSize: 11,
                color: AppColors.danger,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Same "numbered badge + text" language as `link_machine_screen.dart`'s `_StepTitle` — sized
/// identically (20px badge, 12px w600 text) now that this dialog is single-column and no longer
/// needs to be squeezed into a ~250px card, so the two linking surfaces read as one design.
class _ActionStep extends StatelessWidget {
  final int number;
  final String text;

  const _ActionStep({required this.number, required this.text});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 20,
          height: 20,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: AppColors.accent,
            shape: BoxShape.circle,
          ),
          child: Text(
            '$number',
            style: TextStyle(
              color: AppColors.background,
              fontSize: 11,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: TextStyle(
              fontFamily: AppFonts.sans,
              fontFamilyFallback: AppFonts.sansFallback,
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: AppColors.text,
            ),
          ),
        ),
      ],
    );
  }
}

/// Two obscured fields (new + confirm) plus a "Set" button — used both for setting a password
/// the first time and, via [onCancel], for changing an existing one.
class _RemotePasswordForm extends StatelessWidget {
  final TextEditingController passwordController;
  final TextEditingController confirmController;
  final bool obscure;
  final VoidCallback onToggleObscure;
  final bool submitting;
  final VoidCallback onSubmit;
  final VoidCallback? onCancel;

  const _RemotePasswordForm({
    required this.passwordController,
    required this.confirmController,
    required this.obscure,
    required this.onToggleObscure,
    required this.submitting,
    required this.onSubmit,
    this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          key: const Key('remote-password-field'),
          controller: passwordController,
          obscureText: obscure,
          style: TextStyle(fontFamily: AppFonts.mono, fontSize: 12.5),
          decoration: InputDecoration(
            hintText: 'New remote password',
            hintStyle: TextStyle(fontFamily: AppFonts.mono, fontSize: 12.5),
            prefixIcon: const Icon(Icons.password, size: 17),
            suffixIcon: IconButton(
              icon: Icon(
                obscure ? Icons.visibility : Icons.visibility_off,
                size: 17,
              ),
              onPressed: onToggleObscure,
            ),
          ),
        ),
        const SizedBox(height: 8),
        TextField(
          key: const Key('remote-password-confirm-field'),
          controller: confirmController,
          obscureText: obscure,
          style: TextStyle(fontFamily: AppFonts.mono, fontSize: 12.5),
          decoration: InputDecoration(
            hintText: 'Confirm password',
            hintStyle: TextStyle(fontFamily: AppFonts.mono, fontSize: 12.5),
            prefixIcon: const Icon(Icons.password, size: 17),
          ),
          onSubmitted: (_) => onSubmit(),
        ),
        const SizedBox(height: 10),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            if (onCancel != null) ...[
              TextButton(
                onPressed: submitting ? null : onCancel,
                child: const Text('Cancel'),
              ),
              const SizedBox(width: 8),
            ],
            FilledButton(
              key: const Key('remote-password-set-button'),
              onPressed: submitting ? null : onSubmit,
              child: submitting
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Set'),
            ),
          ],
        ),
      ],
    );
  }
}

/// Shown once a remote password is already set: the fingerprint to verify on the connecting
/// side, when it was set, and the "Change"/"Clear" actions.
class _RemotePasswordSummary extends StatelessWidget {
  final RemotePasswordStatus status;
  final bool clearing;
  final VoidCallback onChange;
  final VoidCallback onClear;

  const _RemotePasswordSummary({
    required this.status,
    required this.clearing,
    required this.onChange,
    required this.onClear,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(Icons.check_circle, size: 15, color: AppColors.success),
            const SizedBox(width: 6),
            Text(
              'Remote password is set',
              style: TextStyle(
                fontFamily: AppFonts.sans,
                fontFamilyFallback: AppFonts.sansFallback,
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
                color: AppColors.text,
              ),
            ),
          ],
        ),
        if (status.fingerprint != null) ...[
          const SizedBox(height: 8),
          Text(
            "This machine's fingerprint — verify it matches on the other side:",
            style: TextStyle(
              fontFamily: AppFonts.sans,
              fontFamilyFallback: AppFonts.sansFallback,
              fontSize: 10.5,
              color: AppColors.mutedStrong,
            ),
          ),
          const SizedBox(height: 3),
          SelectableText(
            status.fingerprint!,
            style: TextStyle(
              fontFamily: AppFonts.mono,
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: AppColors.text,
            ),
          ),
        ],
        if (status.setAt != null) ...[
          const SizedBox(height: 4),
          Text(
            'Set on ${_formatDate(status.setAt!)}.',
            style: TextStyle(
              fontFamily: AppFonts.sans,
              fontFamilyFallback: AppFonts.sansFallback,
              fontSize: 10.5,
              color: AppColors.muted,
            ),
          ),
        ],
        const SizedBox(height: 10),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            TextButton(
              key: const Key('remote-password-clear-button'),
              onPressed: clearing ? null : onClear,
              child: const Text('Clear'),
            ),
            const SizedBox(width: 8),
            FilledButton(
              key: const Key('remote-password-change-button'),
              onPressed: clearing ? null : onChange,
              child: const Text('Change'),
            ),
          ],
        ),
      ],
    );
  }

  String _formatDate(DateTime date) {
    final local = date.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${local.year}-${two(local.month)}-${two(local.day)}';
  }
}

/// Two [_LinkedMachineRow]s before `harness link list` has answered: a name,
/// a mono line for the fingerprint, and the room the Unlink button takes.
///
/// Two, because this sits in a dialog and most accounts link one or two
/// machines; a skeleton taller than the answer jumps up when it lands.
class _LinkedMachinesSkeleton extends StatelessWidget {
  const _LinkedMachinesSkeleton({super.key});

  static const _names = [128.0, 96.0];

  @override
  Widget build(BuildContext context) => SkeletonList(
    rows: 2,
    fadeDepth: skeletonFadeLight,
    semanticsLabel: 'Loading linked machines',
    itemBuilder: (context, i) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                SkeletonText(
                  style: TextStyle(
                    fontFamily: AppFonts.sans,
                    fontFamilyFallback: AppFonts.sansFallback,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                  width: _names[i],
                ),
                SkeletonText(
                  style: TextStyle(fontFamily: AppFonts.mono, fontSize: 10.5),
                  widthFactor: 0.72,
                ),
              ],
            ),
          ),
          // A TextButton's box: Material's 40px minimum, the label's width.
          const Skeleton(width: 58, height: 40, radius: 8),
        ],
      ),
    ),
  );
}

class _LinkedMachineRow extends StatelessWidget {
  final LinkedMachine machine;
  final String? displayName;
  final Future<void> Function() onUnlink;

  const _LinkedMachineRow({
    required this.machine,
    required this.displayName,
    required this.onUnlink,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  displayName ?? machine.machineId,
                  style: TextStyle(
                    fontFamily: AppFonts.sans,
                    fontFamilyFallback: AppFonts.sansFallback,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: AppColors.text,
                  ),
                ),
                Text(
                  '${machine.fingerprint} · linked ${machine.linkedAt}',
                  style: TextStyle(
                    fontFamily: AppFonts.mono,
                    fontSize: 10.5,
                    color: AppColors.mutedStrong,
                  ),
                ),
              ],
            ),
          ),
          TextButton(
            key: Key('unlink-${machine.machineId}'),
            onPressed: () => unawaited(onUnlink()),
            child: const Text('Unlink'),
          ),
        ],
      ),
    );
  }
}
