import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../core/harness_cli_runner.dart';
import '../../logging/log_file.dart';
import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/app_icon_button.dart';

/// Where the CLI this app drives actually resolved to, and where the logs it
/// writes are.
///
/// The first thing to check when commands fail — a wrong path, or a launcher
/// that predates the managed runtime — and the app is the only thing that
/// knows, because none of it comes from PATH (see [HarnessCliRunner]).
class DebugEnvironment {
  const DebugEnvironment({
    required this.harnessCommand,
    required this.harnessSource,
    required this.logsDirectory,
  });

  /// The real invocation, argv and all: on the managed tier that is
  /// `<node> <cli.js>`, which is the part a developer is checking.
  final String harnessCommand;

  /// Which of the three tiers answered — managed, launcher, or bare PATH.
  final HarnessCliSource harnessSource;

  final String logsDirectory;
}

/// Resolves the CLI. Injected in tests, which must not read a real
/// `~/.harness`.
Future<DebugEnvironment> probeDebugEnvironment() async {
  final invocation = await HarnessCliRunner().resolve(const []);
  return DebugEnvironment(
    harnessCommand: [
      invocation.executable,
      ...invocation.arguments,
    ].join(' ').trim(),
    harnessSource: invocation.source,
    logsDirectory: DailyLogFile.defaultDirectory.path,
  );
}

class DebugPathsCard extends StatefulWidget {
  const DebugPathsCard({super.key, this.probe = probeDebugEnvironment});

  final Future<DebugEnvironment> Function() probe;

  @override
  State<DebugPathsCard> createState() => _DebugPathsCardState();
}

class _DebugPathsCardState extends State<DebugPathsCard> {
  late Future<DebugEnvironment> _environment = widget.probe();

  void _recheck() => setState(() => _environment = widget.probe());

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 11, 8, 12),
      decoration: BoxDecoration(
        color: AppGlass.surfaceFill,
        borderRadius: BorderRadius.circular(14),
        boxShadow: AppGlass.cardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                LucideIcons.terminal300,
                size: 15,
                color: AppPalette.textFaint,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'What this app is running',
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
              AppIconButton(
                icon: LucideIcons.refreshCw,
                tooltip: 'Re-check',
                onPressed: _recheck,
              ),
            ],
          ),
          const SizedBox(height: 6),
          FutureBuilder<DebugEnvironment>(
            future: _environment,
            builder: (context, snapshot) {
              final environment = snapshot.data;
              if (environment == null) {
                return const _PathRow(label: 'harness', value: 'resolving…');
              }
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _PathRow(
                    label: 'harness',
                    value:
                        '${environment.harnessCommand}  '
                        '(${environment.harnessSource.name})',
                  ),
                  _PathRow(label: 'logs', value: environment.logsDirectory),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _PathRow extends StatelessWidget {
  const _PathRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 62,
            child: Text(
              label,
              style: TextStyle(fontSize: 12, color: AppPalette.textFaint),
            ),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: TextStyle(
                fontSize: 12,
                height: 1.4,
                fontFamily: AppFont.mono,
                fontFamilyFallback: AppFont.monoFallback,
                color: AppPalette.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
