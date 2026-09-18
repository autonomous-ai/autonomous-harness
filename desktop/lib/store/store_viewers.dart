import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/dsh_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;

/// Shared packages are inspected here, separately from browsing harnesses.
class StoreViewers extends StatelessWidget {
  const StoreViewers({
    super.key,
    required this.viewers,
    required this.agents,
    required this.installedOn,
    required this.onOpenAgent,
    required this.loaded,
  });

  final List<DshEntry> viewers;
  final List<DshEntry> agents;
  final List<String> Function(String id) installedOn;
  final ValueChanged<String> onOpenAgent;
  final bool loaded;

  @override
  Widget build(BuildContext context) => ListView(
    key: const ValueKey('store-viewers'),
    padding: const EdgeInsets.all(28),
    children: [
      Text(
        'Viewers',
        style: TextStyle(
          fontSize: 28,
          fontWeight: FontWeight.w700,
          color: grid.AppPalette.textPrimary,
        ),
      ),
      const SizedBox(height: 8),
      Text(
        'Shared previews and the agents that use them.',
        style: TextStyle(fontSize: 13, color: grid.AppPalette.textSecondary),
      ),
      const SizedBox(height: 24),
      if (viewers.isEmpty)
        Text(
          loaded
              ? 'No viewers reported by this computer.'
              : 'Asking this computer…',
          style: TextStyle(color: grid.AppPalette.textSecondary),
        ),
      for (final viewer in viewers) _viewer(context, viewer),
    ],
  );

  Widget _viewer(BuildContext context, DshEntry viewer) {
    final machines = installedOn(viewer.id);
    final uses =
        <String, DshEntry>{
          for (final agent in agents)
            if (!agent.isViewerPackage && agent.viewerUse == viewer.id)
              agent.id: agent,
        }.values.toList()..sort(
          (a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()),
        );
    return Container(
      key: ValueKey('store-viewer:${viewer.id}'),
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: grid.AppSurface.recess,
        border: Border.all(color: grid.AppPalette.divider),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                LucideIcons.panelsTopLeft300,
                size: 20,
                color: grid.AppPalette.textSecondary,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  viewer.name,
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: grid.AppPalette.textPrimary,
                  ),
                ),
              ),
              TextButton(
                key: ValueKey('store-viewer-action:${viewer.id}'),
                onPressed: () => onOpenAgent(viewer.id),
                child: Text(viewer.hasUpdate ? 'Update' : 'View'),
              ),
            ],
          ),
          if (viewer.description?.isNotEmpty == true) ...[
            const SizedBox(height: 8),
            Text(
              viewer.description!,
              style: TextStyle(
                fontSize: 13,
                height: 1.4,
                color: grid.AppPalette.textSecondary,
              ),
            ),
          ],
          const SizedBox(height: 10),
          Text(
            machines.isEmpty
                ? 'Not installed'
                : 'Installed on ${machines.join(', ')}',
            style: TextStyle(
              fontSize: 12,
              color: grid.AppPalette.textSecondary,
            ),
          ),
          const SizedBox(height: 14),
          Text(
            'Used by',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: grid.AppPalette.textSecondary,
            ),
          ),
          const SizedBox(height: 4),
          if (uses.isEmpty)
            Text(
              'No agents reported in this catalog.',
              style: TextStyle(
                fontSize: 13,
                color: grid.AppPalette.textSecondary,
              ),
            )
          else
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final agent in uses)
                  TextButton(
                    key: ValueKey(
                      'store-viewer-agent:${viewer.id}:${agent.id}',
                    ),
                    onPressed: () => onOpenAgent(agent.id),
                    child: Text(agent.name),
                  ),
              ],
            ),
        ],
      ),
    );
  }
}
