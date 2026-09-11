import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';

/// Opens [LinkMachineScreen] as a modal popup for [machineId], closing itself automatically once
/// linking succeeds or the prompt is dismissed (including a barrier tap/Escape, which counts as an
/// implicit dismiss so the caller's reactive gate doesn't just reopen it next frame).
///
/// This is a deliberate exception to the pane grid's normal "never block other tiles" rule (see
/// `AppNotifier.showMachinePane`'s doc comment) — a machine that still needs linking has nothing
/// else useful to show in its own tile, and a transient blocking prompt reads better here than a
/// permanent docked panel that looks like a second tab.
Future<void> showLinkMachineScreenDialog(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
) async {
  await showAppDialog<void>(
    context: context,
    builder: (context) => Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
      child: ListenableBuilder(
        listenable: notifier,
        builder: (context, _) {
          final state = notifier.stateOf(machineId);
          final stillNeeded =
              state != null &&
              state.needsLink &&
              !notifier.isLinkPromptDismissed(machineId);
          if (!stillNeeded) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (Navigator.of(context).canPop()) Navigator.of(context).pop();
            });
            return const SizedBox.shrink();
          }
          return LinkMachineScreen(notifier: notifier, machineState: state);
        },
      ),
    ),
  );
  // Any close that isn't "linked successfully" (barrier tap, Escape, the in-card Close button)
  // must count as a dismiss, or the caller's reactive gate would just reopen this next rebuild.
  final state = notifier.stateOf(machineId);
  if (state != null && state.needsLink) {
    notifier.dismissLinkPrompt(machineId);
  }
}

/// Shown for a remote machine the local CLI's relay has no linked trust for yet. The CLI now owns
/// E2EE entirely (see the harness CLI's `harness remote-password set`/`harness link connect`, and
/// src/lib/remoteRelay.ts) — this screen holds no crypto state, it just walks the user through
/// entering the remote password set on the OTHER machine.
class LinkMachineScreen extends StatefulWidget {
  final AppNotifier notifier;
  final MachineState machineState;
  const LinkMachineScreen({
    super.key,
    required this.notifier,
    required this.machineState,
  });

  @override
  State<LinkMachineScreen> createState() => _LinkMachineScreenState();
}

class _LinkMachineScreenState extends State<LinkMachineScreen> {
  final _passwordController = TextEditingController();
  bool _obscure = true;
  bool _submitting = false;
  bool _showTroubleshootingDetails = false;
  String? _error;
  String? _stage;

  @override
  void dispose() {
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _submitting = true;
      _error = null;
      _stage = null;
    });
    final error = await widget.notifier.connectWithPassword(
      widget.machineState.machine.machineId,
      _passwordController.text,
      onProgress: (stage) {
        if (mounted) setState(() => _stage = stage);
      },
    );
    if (!mounted) return;
    setState(() {
      _submitting = false;
      _error = error;
      _stage = null;
    });
    if (error == null) _passwordController.clear();
  }

  @override
  Widget build(BuildContext context) {
    final machineId = widget.machineState.machine.machineId;
    final machineName = widget.machineState.machine.displayName;

    return Container(
      width: 460,
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(14),
        color: AppColors.surface,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.link, size: 32, color: AppColors.accent),
          const SizedBox(height: 6),
          Text(
            'Link this machine',
            style: TextStyle(
              fontFamily: AppFonts.sans,
              fontFamilyFallback: AppFonts.sansFallback,
              fontSize: 13.5,
              fontWeight: FontWeight.w600,
              color: AppColors.text,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            "This computer isn't linked to $machineName yet. Enter the remote password set "
            'on that machine to connect.',
            style: TextStyle(
              fontFamily: AppFonts.sans,
              fontFamilyFallback: AppFonts.sansFallback,
              fontSize: 11.2,
              color: AppColors.mutedStrong,
            ),
          ),
          const SizedBox(height: 14),
          TextField(
            key: const Key('remote-password-connect-field'),
            controller: _passwordController,
            obscureText: _obscure,
            style: TextStyle(
              fontFamily: AppFonts.mono,
              fontSize: 12.5,
              color: AppColors.textSoft,
            ),
            decoration: InputDecoration(
              hintText: 'Remote password for $machineName',
              hintStyle: TextStyle(fontFamily: AppFonts.mono, fontSize: 12.5),
              prefixIcon: const Icon(Icons.password, size: 17),
              suffixIcon: IconButton(
                icon: Icon(
                  _obscure ? Icons.visibility : Icons.visibility_off,
                  size: 17,
                ),
                onPressed: () => setState(() => _obscure = !_obscure),
              ),
            ),
            onSubmitted: (_) => _submit(),
          ),
          if (_error != null) ...[
            const SizedBox(height: 6),
            Text(
              _error!,
              style: TextStyle(
                fontFamily: AppFonts.sans,
                fontFamilyFallback: AppFonts.sansFallback,
                fontSize: 11.2,
                color: AppColors.danger,
              ),
            ),
          ],
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              if (_submitting && _stage != null) ...[
                Text(
                  _stage!,
                  style: TextStyle(
                    fontFamily: AppFonts.sans,
                    fontFamilyFallback: AppFonts.sansFallback,
                    fontSize: 11.2,
                    color: AppColors.mutedStrong,
                  ),
                ),
                const SizedBox(width: 10),
              ],
              FilledButton(
                key: const Key('remote-password-connect-button'),
                onPressed: _submitting ? null : _submit,
                child: _submitting
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Link machine'),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Your previous agent will reconnect automatically after linking.',
            style: TextStyle(
              fontFamily: AppFonts.sans,
              fontSize: 11.2,
              color: AppColors.mutedStrong,
            ),
          ),
          const SizedBox(height: 4),
          TextButton.icon(
            key: const Key('link-troubleshooting-details'),
            onPressed: () => setState(
              () => _showTroubleshootingDetails = !_showTroubleshootingDetails,
            ),
            icon: Icon(
              _showTroubleshootingDetails
                  ? Icons.expand_less
                  : Icons.expand_more,
              size: 16,
            ),
            label: const Text('Troubleshooting details'),
          ),
          if (_showTroubleshootingDetails)
            Padding(
              padding: const EdgeInsets.only(left: 12),
              child: SelectableText(
                'Machine ID: $machineId',
                style: TextStyle(
                  fontFamily: AppFonts.mono,
                  fontSize: 11.2,
                  color: AppColors.muted,
                ),
              ),
            ),
          // An explicit way out, in addition to the barrier tap/Escape that
          // showLinkMachineScreenDialog already treats as an implicit dismiss. Closing does
          // not pretend the machine is linked: it still cannot be read and the rail still
          // says so. It only stops the popup from insisting, and choosing that machine again
          // brings it straight back. Bottom-right text button, matching every other dialog in
          // the app (see link_machine_dialog.dart's 'Close').
          const SizedBox(height: 6),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              style: TextButton.styleFrom(
                minimumSize: Size.zero,
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              onPressed: () => widget.notifier.dismissLinkPrompt(machineId),
              child: const Text('Close'),
            ),
          ),
        ],
      ),
    );
  }
}
