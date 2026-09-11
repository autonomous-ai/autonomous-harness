import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import 'login_relay_diagram.dart';

/// The quiet bridge between opening Harness and reaching the user's workspace.
///
/// Bootstrap does not expose truthful percentage progress, so this screen names
/// the current operation without inventing steps or a completion estimate. It
/// shares the sign-in and pre-flight visual language so startup feels like one
/// product instead of a framework spinner between two designed screens.
class BootstrappingScreen extends StatelessWidget {
  const BootstrappingScreen({super.key, this.statusMessage});

  final String? statusMessage;

  static const double _cardWidth = 420;
  static const String _fallbackStatus = 'Opening Harness…';

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final status = statusMessage ?? _fallbackStatus;

    return Scaffold(
      backgroundColor: grid.AppPalette.panelBg,
      body: Stack(
        children: [
          const Positioned.fill(child: LoginAurora()),
          Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: _cardWidth),
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(32),
                  decoration: BoxDecoration(
                    color: grid.AppGlass.surfaceFill,
                    borderRadius: BorderRadius.circular(grid.AppCard.radius),
                    boxShadow: grid.AppCard.shadow,
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const _BootAppMark(),
                      const SizedBox(height: 20),
                      Text(
                        'Getting Harness ready',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Connecting this window to the local Harness service.',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      const SizedBox(height: 24),
                      Semantics(
                        key: const Key('boot-status'),
                        container: true,
                        liveRegion: true,
                        label: 'Harness startup status',
                        value: status,
                        child: ExcludeSemantics(
                          child: Container(
                            width: double.infinity,
                            padding: const EdgeInsets.symmetric(
                              horizontal: 16,
                              vertical: 14,
                            ),
                            decoration: BoxDecoration(
                              color: grid.AppCard.inset,
                              borderRadius: BorderRadius.circular(
                                grid.AppCard.insetRadius,
                              ),
                              border: Border.all(color: grid.AppCard.insetHair),
                            ),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                TickerMode(
                                  key: const Key('boot-status-ticker'),
                                  enabled: !reduceMotion,
                                  child: const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Flexible(
                                  child: AnimatedSwitcher(
                                    duration: reduceMotion
                                        ? Duration.zero
                                        : const Duration(milliseconds: 180),
                                    child: Text(
                                      status,
                                      key: ValueKey(status),
                                      textAlign: TextAlign.center,
                                      style: Theme.of(context)
                                          .textTheme
                                          .labelLarge,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(
                        'This usually takes a few seconds.',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.labelSmall
                            ?.copyWith(color: grid.AppPalette.textSecondary),
                      ),
                    ],
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

class _BootAppMark extends StatelessWidget {
  const _BootAppMark();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      width: 56,
      height: 56,
      decoration: BoxDecoration(
        color: grid.AppCard.inset,
        borderRadius: BorderRadius.circular(12),
      ),
      alignment: Alignment.center,
      child: Image.asset(
        'assets/app_icon.png',
        width: 36,
        height: 36,
        filterQuality: FilterQuality.medium,
      ),
    );
  }
}
