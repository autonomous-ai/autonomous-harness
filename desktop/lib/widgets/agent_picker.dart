import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/widgets/app_choice_picker.dart';
import '../shared/widgets/app_select_field.dart';
import 'engine_identity.dart';

class AgentPicker extends StatelessWidget {
  const AgentPicker({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    this.compact = false,
    this.tileSize,
  });
  final String value;
  final List<SelectOption<String>> options;
  final ValueChanged<String> onChanged;
  final bool compact;
  final Size? tileSize;

  /// The preferred order: the three engines the tiles show, then the two
  /// first-party domain harnesses, first in More; a chosen one is what the
  /// More tile then shows.
  static const quickAgents = [
    'codex',
    'claude',
    'opencode',
    'autonomous/autonomous-circuit',
    'autonomous/autonomous-workshop',
    'autonomous/marp',
  ];

  @override
  Widget build(BuildContext context) => AppChoicePicker<String>(
    value: value,
    compact: compact,
    tileSize: tileSize,
    options: [
      for (final option in options)
        SelectOption(
          value: option.value,
          label: option.value == 'claude' ? 'Claude Code' : option.label,
          note: option.note,
          detail: option.detail,
          leading: () => EngineMark(
            engine: option.value,
            size: tileSize == null ? 18 : 22,
          ),
          trailing: option.trailing,
        ),
    ],
    preferredValues: quickAgents,
    // In More, the harnesses come before the engines. What is left after the
    // three tiles is eleven more coding engines — which a person who wanted a
    // coding engine has already been offered — and the domain harnesses, which
    // are the reason to open this menu at all.
    overflowFirst: isHarnessId,
    onChanged: onChanged,
    notifyOnReselect: true,
    optionKey: (id) => ValueKey('new-agent-quick-$id'),
    moreKey: const Key('new-agent-engine-field'),
    moreLabel: 'More agents',
    moreLeading: Icon(LucideIcons.layoutGrid, size: tileSize == null ? 18 : 22),
  );
}
