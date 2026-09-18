import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../ws/ws_conn.dart';

typedef ShareAction = Future<Map<String, dynamic>> Function(
  String action,
  Map<String, dynamic> payload,
);

Future<void> showShareHarnessDialog(
  BuildContext context,
  AppNotifier app,
  String machineId,
  String agentId,
  String name,
) => showAppDialog<void>(
  context: context,
  builder: (_) => ShareHarnessDialog(
    name: name,
    manage: (action, payload) =>
        app.manageHarnessShares(machineId, agentId, action, payload),
  ),
);

class ShareHarnessDialog extends StatefulWidget {
  const ShareHarnessDialog({
    super.key,
    required this.name,
    required this.manage,
  });
  final String name;
  final ShareAction manage;
  @override
  State<ShareHarnessDialog> createState() => _ShareHarnessDialogState();
}

class _ShareHarnessDialogState extends State<ShareHarnessDialog> {
  final _emails = TextEditingController();
  List<Map<String, dynamic>> _shares = [];
  bool _loading = true, _busy = false;
  String? _error, _notice;
  int _days = 30;
  Timer? _presence;
  int _revision = 0;
  bool _refreshing = false;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
    _presence = Timer.periodic(const Duration(seconds: 5), (_) {
      if (!_busy) unawaited(_load(quiet: true));
    });
  }

  @override
  void dispose() {
    _presence?.cancel();
    _emails.dispose();
    super.dispose();
  }

  String _message(Object error) =>
      error is WsRequestFailure && error.code == 'UNSUPPORTED'
      ? 'Update Harness on this machine to start sharing.'
      : error is WsRequestFailure && error.detail != null
      ? error.detail!
      : 'Could not reach this harness. Check the connection and try again.';
  void _accept(Map<String, dynamic> response) {
    _shares = [
      for (final row in response['shares'] as List? ?? const [])
        Map<String, dynamic>.from(row as Map),
    ];
  }

  Future<void> _load({bool quiet = false}) async {
    if (_refreshing || _busy) return;
    _refreshing = true;
    final revision = _revision;
    try {
      final response = await widget.manage('list', const {});
      if (mounted && revision == _revision) {
        setState(() {
          _accept(response);
          _loading = false;
          if (!quiet) _error = null;
        });
      }
    } catch (error) {
      if (mounted && !quiet && revision == _revision) {
        setState(() {
          _loading = false;
          _error = _message(error);
        });
      }
    } finally {
      _refreshing = false;
    }
  }

  Future<void> _invite() async {
    if (_busy) return;
    final emails = _emails.text
        .split(RegExp(r'[,;\s]+'))
        .where((e) => e.isNotEmpty)
        .map((e) => e.toLowerCase())
        .toSet()
        .toList();
    if (emails.isEmpty ||
        emails.length > 20 ||
        emails.any((e) => !RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(e))) {
      setState(() {
        _error = 'Enter up to 20 valid email addresses, separated by commas.';
        _notice = null;
      });
      return;
    }
    setState(() {
      _revision++;
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final response = await widget.manage('invite', {
        'emails': emails,
        'days': _days,
      });
      if (mounted) {
        setState(() {
          _accept(response);
          _emails.clear();
          _notice = _shares.any((s) => s['error'] != null)
              ? 'Some invitations could not be shared. Check the details below.'
              : _shares.any((s) => s['pending'] == true)
              ? 'Invitations saved. They will appear when the connection returns.'
              : '${emails.length == 1 ? '1 person now has' : '${emails.length} people now have'} view-only access.';
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = _message(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove(String id) async {
    if (_busy) return;
    setState(() {
      _revision++;
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final response = await widget.manage('remove', {'id': id});
      if (mounted) {
        setState(() {
          _accept(response);
          _notice = 'Access removed.';
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = _message(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return AlertDialog(
      title: Row(
        children: [
          const Icon(Icons.people_outline, size: 22),
          const SizedBox(width: 12),
          const Expanded(child: Text('Share harness')),
        ],
      ),
      content: SizedBox(
        width: 520,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * .65,
          ),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  widget.name,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 6),
                Text(
                  'Let people watch your agent and its live output.',
                  style: TextStyle(color: grid.AppPalette.textSecondary),
                ),
                const SizedBox(height: 22),
                TextField(
                  controller: _emails,
                  autofocus: true,
                  enabled: !_busy && !_loading,
                  keyboardType: TextInputType.emailAddress,
                  maxLines: 2,
                  minLines: 1,
                  decoration: const InputDecoration(
                    labelText: 'Add people by email',
                    hintText: 'ken@example.com, diego@example.com',
                  ),
                  onSubmitted: (_) => _invite(),
                  onChanged: (_) => setState(() {}),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    const Icon(Icons.visibility_outlined, size: 16),
                    const SizedBox(width: 8),
                    const Text('Can view'),
                    const Spacer(),
                    AppSelectField<int>(
                      value: _days,
                      width: 156,
                      options: const [
                        SelectOption(value: 7, label: 'Expires in 7 days'),
                        SelectOption(value: 30, label: 'Expires in 30 days'),
                        SelectOption(value: 90, label: 'Expires in 90 days'),
                      ],
                      onChanged: (value) {
                        if (!_busy) setState(() => _days = value);
                      },
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: _busy || _loading || _emails.text.trim().isEmpty
                      ? null
                      : _invite,
                  child: Text(_busy ? 'Saving…' : 'Share harness'),
                ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Semantics(
                      liveRegion: true,
                      child: Text(
                        _error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  ),
                if (_notice != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Semantics(liveRegion: true, child: Text(_notice!)),
                  ),
                const SizedBox(height: 24),
                const Text(
                  'People with access',
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 10),
                if (_loading)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: Skeleton(height: 44),
                  ),
                if (!_loading && _shares.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Text(
                      'Only you have access.',
                      style: TextStyle(color: grid.AppPalette.textSecondary),
                    ),
                  ),
                for (final share in _shares) _recipient(share),
                const SizedBox(height: 18),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: grid.AppSurface.recess,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Text(
                    'They’ll find this harness in Machines → Shared with you using the invited email. '
                    'Keep your machine online while they watch. You can remove access at any time.',
                    style: TextStyle(fontSize: 12, height: 1.5),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      actions: [
        if (_error != null && !_busy)
          TextButton(onPressed: () => _load(), child: const Text('Retry')),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Done'),
        ),
      ],
    );
  }

  Widget _recipient(Map<String, dynamic> share) {
    final email = share['email'] as String;
    final watching = (share['watching'] as num? ?? 0) > 0;
    final expires = DateTime.tryParse(share['expiresAt'] as String? ?? '')
        ?.toLocal();
    final subtitle =
        share['error'] as String? ??
        (share['pending'] == true
            ? 'Waiting for connection'
            : share['expired'] == true
            ? 'Expired · add again to renew'
            : watching
            ? 'Watching now · Can view'
            : 'Can view${expires == null ? '' : ' · Until ${expires.month}/${expires.day}/${expires.year}'}');
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: CircleAvatar(
        radius: 16,
        backgroundColor: grid.AppSurface.recess,
        child: Text(
          email.substring(0, 1).toUpperCase(),
          style: const TextStyle(fontSize: 13),
        ),
      ),
      title: Text(
        email,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 13),
      ),
      subtitle: Text(subtitle, style: const TextStyle(fontSize: 11)),
      trailing: TextButton(
        onPressed: _busy ? null : () => _remove(share['id'] as String),
        child: const Text('Remove'),
      ),
    );
  }
}
