import 'package:flutter/material.dart';

import '../bootstrap/environment_provisioner.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'login_relay_diagram.dart';

/// The quiet read-only gate shown before either sign-in or environment setup.
///
/// This is deliberately not part of the environment setup wizard: a computer that
/// is already ready should never look as though it has entered an installer.
/// The ready state has no artificial dwell or action; it stays visible only
/// while the app asks the local Harness CLI whether this user is signed in.
class EnvironmentPreflightScreen extends StatelessWidget {
  const EnvironmentPreflightScreen({super.key, required this.readiness});

  final EnvironmentReadiness readiness;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final ready = readiness.isReady;

    return Scaffold(
      backgroundColor: grid.AppPalette.panelBg,
      body: Stack(
        children: [
          const Positioned.fill(child: LoginAurora()),
          Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(32),
                  decoration: BoxDecoration(
                    color: grid.AppGlass.surfaceFill,
                    borderRadius: BorderRadius.circular(14),
                    boxShadow: grid.AppCard.shadow,
                  ),
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 180),
                    child: ready
                        ? const _ReadyContent(
                            key: ValueKey('environment-ready'),
                          )
                        : const _CheckingContent(
                            key: ValueKey('environment-checking'),
                          ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CheckingContent extends StatelessWidget {
  const _CheckingContent({super.key});

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      const SizedBox(
        width: 34,
        height: 34,
        child: CircularProgressIndicator(strokeWidth: 2.5),
      ),
      const SizedBox(height: 24),
      Text(
        'Checking this computer',
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.titleLarge,
      ),
      const SizedBox(height: 8),
      Text(
        'Verifying the tools Harness needs. This check is read-only and nothing is being installed.',
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodySmall,
      ),
    ],
  );
}

class _ReadyContent extends StatelessWidget {
  const _ReadyContent({super.key});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final success = grid.AppPalette.online;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: success.withValues(alpha: 0.12),
            shape: BoxShape.circle,
          ),
          alignment: Alignment.center,
          child: Icon(Icons.check_rounded, size: 28, color: success),
        ),
        const SizedBox(height: 20),
        Text(
          'Environment ready',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 8),
        Text(
          'All required tools passed verification.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}
