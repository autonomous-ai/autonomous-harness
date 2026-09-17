import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart';
import '../shared/widgets/app_dialog.dart';
import 'engine_identity.dart';

enum HarnessHelpTopic { agent, machine, project }

/// Optional guidance beside the choices it explains. A separate route keeps
/// the form, its scroll position and its keyboard shortcuts underneath it.
class HarnessHelpLink extends StatefulWidget {
  const HarnessHelpLink({super.key, required this.topic});

  final HarnessHelpTopic topic;

  @override
  State<HarnessHelpLink> createState() => _HarnessHelpLinkState();
}

class _HarnessHelpLinkState extends State<HarnessHelpLink> {
  final _focus = FocusNode();

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  Future<void> _open() async {
    await showAppDialog<void>(
      context: context,
      builder: (_) => _HarnessHelpDialog(topic: widget.topic),
    );
    if (mounted) _focus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final label = switch (widget.topic) {
      HarnessHelpTopic.agent => 'Need help choosing?',
      HarnessHelpTopic.machine => 'Local or remote?',
      HarnessHelpTopic.project => 'Where to start?',
    };
    return TextButton(
      key: ValueKey('harness-help-${widget.topic.name}'),
      focusNode: _focus,
      onPressed: _open,
      style:
          TextButton.styleFrom(
            foregroundColor: AppPalette.textSecondary,
            minimumSize: const Size(0, 32),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            textStyle: TextStyle(
              fontFamily: AppFont.sans,
              fontFamilyFallback: AppFont.sansFallback,
              fontSize: 14,
              fontWeight: FontWeight.w400,
              height: 1.4,
            ),
            side: BorderSide.none,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(6),
            ),
          ).copyWith(
            // Keep hover and keyboard focus visible without making guidance
            // look like another selected agent, machine or project.
            overlayColor: WidgetStateProperty.resolveWith(
              (states) => states.contains(WidgetState.pressed)
                  ? AppSurface.selectedFill
                  : states.contains(WidgetState.hovered) ||
                        states.contains(WidgetState.focused)
                  ? AppSurface.hoverFill
                  : Colors.transparent,
            ),
          ),
      child: Text(label),
    );
  }
}

class _HarnessHelpDialog extends StatefulWidget {
  const _HarnessHelpDialog({required this.topic});

  final HarnessHelpTopic topic;

  @override
  State<_HarnessHelpDialog> createState() => _HarnessHelpDialogState();
}

class _HarnessHelpDialogState extends State<_HarnessHelpDialog> {
  final _scroll = ScrollController();

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final compact = MediaQuery.sizeOf(context).width < 700;
    final (title, intro) = switch (widget.topic) {
      HarnessHelpTopic.agent => (
        'What would you like to make?',
        'Choose an agent for the kind of work you have in mind. '
            'You’ll work with it inside your new harness.',
      ),
      HarnessHelpTopic.machine => (
        'Where would you like to work?',
        'Your agent runs its tools and works with files on the machine you choose.',
      ),
      HarnessHelpTopic.project => (
        'Start with a place for your work.',
        'A project is the folder your agent works in. '
            'All of these options use the machine you’ve selected.',
      ),
    };
    return Dialog(
      key: ValueKey('harness-help-guide-${widget.topic.name}'),
      backgroundColor: AppPalette.swarmField,
      surfaceTintColor: Colors.transparent,
      insetPadding: EdgeInsets.all(compact ? 16 : 24),
      constraints: const BoxConstraints(maxWidth: 800, maxHeight: 920),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
      clipBehavior: Clip.antiAlias,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
            child: Align(
              alignment: Alignment.centerRight,
              child: IconButton(
                key: const Key('harness-help-close'),
                autofocus: true,
                tooltip: 'Close guide',
                onPressed: () => Navigator.of(context).pop(),
                style: IconButton.styleFrom(
                  backgroundColor: AppSurface.recess,
                  foregroundColor: AppPalette.textSecondary,
                  minimumSize: const Size(40, 40),
                  shape: const CircleBorder(),
                ),
                icon: const Icon(LucideIcons.x, size: 22),
              ),
            ),
          ),
          Flexible(
            child: Scrollbar(
              controller: _scroll,
              child: SingleChildScrollView(
                controller: _scroll,
                padding: EdgeInsets.fromLTRB(
                  compact ? 24 : 48,
                  16,
                  compact ? 24 : 48,
                  compact ? 28 : 48,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Semantics(
                      header: true,
                      child: Text(
                        title,
                        style: TextStyle(
                          fontSize: compact ? 28 : 32,
                          height: 1.2,
                          fontWeight: AppFont.semibold,
                          color: AppPalette.textPrimary,
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),
                    Text(
                      intro,
                      style: TextStyle(
                        fontSize: 16,
                        height: 1.5,
                        color: AppPalette.textSecondary,
                      ),
                    ),
                    const SizedBox(height: 32),
                    ..._sections(),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _sections() => switch (widget.topic) {
    HarnessHelpTopic.agent => const [
      _HelpOption(
        leading: EngineMark(engine: 'codex', size: 32),
        title: 'Code',
        description:
            'Build apps, fix bugs, and work with existing code. '
            'Start with an agent you already use, such as Codex, Claude Code, or OpenCode.',
      ),
      _HelpOption(
        leading: EngineMark(engine: 'autonomous/autonomous-workshop', size: 32),
        title: 'Autonomous Workshop · CAD',
        description:
            'Design parts and objects with a live 3D view. '
            'Use it for prototypes, enclosures, and parts you want to 3D print.',
      ),
      _HelpOption(
        leading: EngineMark(engine: 'autonomous/autonomous-circuit', size: 32),
        title: 'Autonomous Circuit · PCB',
        description:
            'Design circuit boards with a live board view. '
            'Use it for electronics projects, PCB layouts, and preparing a board for manufacturing.',
      ),
      _HelpOption(
        leading: EngineMark(engine: 'autonomous/marp', size: 32),
        title: 'Marp · Slides',
        description:
            'Create presentations with a live slide preview. '
            'Use it for talks, project updates, and decks you want to export or share.',
        last: true,
      ),
    ],
    HarnessHelpTopic.machine => const [
      _HelpOption(
        leading: Icon(LucideIcons.laptop, size: 28),
        title: 'This computer',
        description:
            'A good place to start. Work with the files and tools on the computer '
            'you’re using, without setting up another machine.',
      ),
      _HelpOption(
        leading: Icon(LucideIcons.monitor, size: 28),
        title: 'Remote machine',
        description:
            'Choose another linked computer when your project or tools are there. '
            'The work happens on that machine while you control it from here. '
            'Keep both computers online while you work.',
        last: true,
      ),
    ],
    HarnessHelpTopic.project => const [
      _HelpOption(
        leading: Icon(LucideIcons.folderPlus, size: 28),
        title: 'New project',
        description: 'Start fresh. Harness creates a new folder on your selected machine for your work.',
      ),
      _HelpOption(
        leading: Icon(LucideIcons.folderOpen, size: 28),
        title: 'Existing folder',
        description:
            'Choose a folder that’s already on your selected machine. '
            'Your new harness will work with the files in that folder.',
      ),
      _HelpOption(
        leading: Icon(LucideIcons.gitBranch, size: 28),
        title: 'Git',
        description:
            'Bring a project from GitHub. Paste a repository link and Harness '
            'clones it onto your selected machine before starting.',
      ),
      _HelpOption(
        leading: Icon(LucideIcons.history, size: 28),
        title: 'Recent',
        description:
            'Quickly choose a project folder you’ve used on this machine before. '
            'This starts a new harness in that folder.',
        last: true,
      ),
    ],
  };
}

class _HelpOption extends StatelessWidget {
  const _HelpOption({
    required this.leading,
    required this.title,
    required this.description,
    this.last = false,
  });

  final Widget leading;
  final String title, description;
  final bool last;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: EdgeInsets.only(bottom: last ? 0 : 24),
      child: Column(
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 36,
                child: IconTheme(
                  data: IconThemeData(color: AppPalette.textSecondary),
                  child: leading,
                ),
              ),
              const SizedBox(width: 20),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        fontSize: 18,
                        height: 1.4,
                        fontWeight: AppFont.semibold,
                        color: AppPalette.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      description,
                      style: TextStyle(
                        fontSize: 16,
                        height: 1.5,
                        color: AppPalette.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (!last) ...[
            const SizedBox(height: 24),
            Divider(
              height: 1,
              color: AppPalette.textFaint.withValues(alpha: .25),
            ),
          ],
        ],
      ),
    );
  }
}
