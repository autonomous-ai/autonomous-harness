import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';

/// Lets the user browse folders ON THE REMOTE MACHINE (via the `fs_list_dir` RPC) and returns the
/// chosen absolute path, or null if cancelled. Desktop-app and the harness CLI usually run on two
/// different computers, so this deliberately does not use a local native file picker.
Future<String?> showRemoteFolderPicker(
  BuildContext context, {
  required AppNotifier notifier,
  required String machineId,
  String? initialPath,
}) {
  return showAppDialog<String>(
    context: context,
    builder: (context) => _RemoteFolderPickerDialog(
      notifier: notifier,
      machineId: machineId,
      initialPath: initialPath,
    ),
  );
}

class _RemoteFolderPickerDialog extends StatefulWidget {
  final AppNotifier notifier;
  final String machineId;
  final String? initialPath;

  const _RemoteFolderPickerDialog({
    required this.notifier,
    required this.machineId,
    this.initialPath,
  });

  @override
  State<_RemoteFolderPickerDialog> createState() =>
      _RemoteFolderPickerDialogState();
}

class _RemoteFolderPickerDialogState extends State<_RemoteFolderPickerDialog> {
  String? _path;
  List<Map<String, dynamic>> _entries = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load(widget.initialPath);
  }

  Future<void> _load(String? path) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final result = await widget.notifier.listRemoteFolder(
      widget.machineId,
      path,
    );
    if (!mounted) return;
    final error = result['error'];
    if (error is String) {
      // Keep whatever `_path`/`_entries` was showing before the failed hop, so a bad click (e.g. a
      // restricted folder) leaves the browser where the user was instead of collapsing to blank.
      setState(() {
        _loading = false;
        _error = error;
      });
      return;
    }
    setState(() {
      _loading = false;
      _path = result['path'] as String?;
      _entries = (result['entries'] as List<dynamic>? ?? [])
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
    });
  }

  List<String> get _segments =>
      (_path ?? '').split('/').where((s) => s.isNotEmpty).toList();

  String _pathUpTo(int index) {
    final prefix = (_path ?? '').startsWith('/') ? '/' : '';
    return prefix + _segments.sublist(0, index + 1).join('/');
  }

  String? get _parentPath {
    if (_segments.length <= 1) return null;
    final prefix = (_path ?? '').startsWith('/') ? '/' : '';
    return prefix + _segments.sublist(0, _segments.length - 1).join('/');
  }

  String _errorMessage(String code) {
    switch (code) {
      case 'FORBIDDEN':
        return "Can't browse outside the home directory on this machine.";
      case 'PERMISSION_DENIED':
        return "Can't open this folder — permission denied.";
      case 'NOT_A_DIRECTORY':
        return 'That path is not a folder.';
      case 'UNREACHABLE':
        return 'Machine is unreachable.';
      default:
        return "Can't open this folder.";
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Choose a folder'),
      content: SizedBox(
        width: 440,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _Breadcrumbs(
              segments: _segments,
              onTap: (i) => _load(_pathUpTo(i)),
            ),
            const SizedBox(height: 10),
            SizedBox(height: 260, child: _buildBody(context)),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _path == null
              ? null
              : () => Navigator.of(context).pop(_path),
          child: const Text('Select this folder'),
        ),
      ],
    );
  }

  Widget _buildBody(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: AppColors.background,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(6),
      ),
      child: _loading
          // Every click into a folder passes through here, so the rows are
          // drawn where rows will be rather than a spinner in the middle of
          // a well that empties and refills on each step.
          ? const _FolderRowsSkeleton(key: Key('folders-skeleton'))
          : _error != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  _errorMessage(_error!),
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: AppColors.danger,
                    fontFamily: AppFonts.sans,
                    fontSize: 11.2,
                  ),
                ),
              ),
            )
          : _entries.isEmpty && _parentPath == null
          ? Center(
              child: Text(
                'No subfolders here.',
                style: TextStyle(
                  color: AppColors.muted,
                  fontFamily: AppFonts.sans,
                  fontSize: 11.2,
                ),
              ),
            )
          : ListView(
              children: [
                if (_parentPath != null)
                  _FolderRow(
                    icon: Icons.arrow_upward,
                    label: '.. (up one level)',
                    onTap: () => _load(_parentPath),
                  ),
                for (final entry in _entries)
                  _FolderRow(
                    icon: Icons.folder_outlined,
                    label: entry['name'] as String? ?? '',
                    onTap: () => _load('${_path ?? ''}/${entry['name']}'),
                  ),
              ],
            ),
    );
  }
}

class _Breadcrumbs extends StatelessWidget {
  final List<String> segments;
  final ValueChanged<int> onTap;

  const _Breadcrumbs({required this.segments, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.background,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(grid.AppCard.insetRadius),
      ),
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          for (var i = 0; i < segments.length; i++) ...[
            if (i > 0)
              Padding(
                padding: EdgeInsets.symmetric(horizontal: 2),
                child: Text(
                  '/',
                  style: TextStyle(color: AppColors.borderStrong),
                ),
              ),
            InkWell(
              onTap: () => onTap(i),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 2),
                child: Text(
                  segments[i],
                  style: TextStyle(
                    fontFamily: AppFonts.sans,
                    fontSize: 13.5,
                    color: i == segments.length - 1
                        ? AppColors.text
                        : AppColors.mutedStrong,
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Five [_FolderRow]s with nothing in them: the glyph's square and a name of
/// varying length, at the row's own padding.
class _FolderRowsSkeleton extends StatelessWidget {
  const _FolderRowsSkeleton({super.key});

  static const _widths = [0.42, 0.28, 0.56, 0.34, 0.48];

  @override
  Widget build(BuildContext context) => SkeletonList(
    rows: _widths.length,
    semanticsLabel: 'Loading folders',
    itemBuilder: (context, i) => Padding(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
      child: Row(
        children: [
          const Skeleton(width: 14, height: 14, radius: 3),
          const SizedBox(width: 9),
          Expanded(
            child: SkeletonText(
              style: TextStyle(fontFamily: AppFonts.sans, fontSize: 13.5),
              widthFactor: _widths[i],
            ),
          ),
        ],
      ),
    ),
  );
}

class _FolderRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  const _FolderRow({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
        child: Row(
          children: [
            Icon(icon, size: 14, color: AppColors.mutedStrong),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                label,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: AppColors.textSoft,
                  fontFamily: AppFonts.sans,
                  fontSize: 13.5,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
