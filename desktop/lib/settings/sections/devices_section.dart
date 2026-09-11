import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../../autonomous_device/autonomous_device_cli.dart';
import '../../core/test_run.dart';
import '../../shared/widgets/app_dialog.dart';
import '../../shared/widgets/app_icon_button.dart';
import '../../shared/widgets/app_select_field.dart';
import '../../shared/widgets/labeled_field.dart';
import '../../shared/widgets/setting_row.dart';
import '../../shared/widgets/skeleton.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/section_scaffold.dart';

class DevicesSection extends StatefulWidget {
  const DevicesSection({super.key, this.cli});
  final AutonomousDeviceCli? cli;
  @override
  State<DevicesSection> createState() => _DevicesSectionState();
}

class _DevicesSectionState extends State<DevicesSection> {
  late final AutonomousDeviceCli _cli = widget.cli ?? AutonomousDeviceCli();
  Timer? _timer;
  final _code = TextEditingController();
  bool _loading = true;
  bool _busy = false;
  bool _refreshing = false;
  int _generation = 0;
  bool _unsupported = false;
  String? _error;
  String? _actionError;
  String? _selectedDevice;
  List<Map<String, dynamic>> _discovered = [];
  Map<String, dynamic> _status = {};
  List<Map<String, dynamic>> _devices = [];

  @override
  void initState() {
    super.initState();
    if (kUnderTest && widget.cli == null) {
      _loading = false;
      return;
    }
    unawaited(_refresh());
  }

  void _scheduleRefresh() {
    _timer?.cancel();
    // Tests may inject a fake for the initial fetch and user actions, but must
    // never start a background clock or invoke a real CLI.
    if (!mounted || kUnderTest || _unsupported || _busy) return;
    _timer = Timer(const Duration(seconds: 60), () {
      unawaited(_refresh());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _code.dispose();
    // Leaving the screen does not revoke trust or stop the daemon.
    super.dispose();
  }

  void _failed(Object error) {
    _error = error is AutonomousDeviceCliException
        ? error.userMessage
        : 'Could not reach the Harness CLI.';
    if (error is AutonomousDeviceCliException && error.unsupported) {
      _unsupported = true;
    }
  }

  Future<void> _refresh() async {
    if (_refreshing || (kUnderTest && widget.cli == null)) return;
    _refreshing = true;
    final generation = _generation;
    try {
      final status = await _cli.status();
      final results = await Future.wait([_cli.list(), _cli.discover()]);
      if (!mounted || generation != _generation) return;
      final devices = <Map<String, dynamic>>[
        for (final row in results[0]['devices'] as List? ?? [])
          if (row is Map<String, dynamic>) row,
      ];
      final discovered = <Map<String, dynamic>>[
        for (final row in results[1]['devices'] as List? ?? [])
          if (row is Map<String, dynamic> &&
              row['id'] is String &&
              (row['id'] as String).isNotEmpty)
            row,
      ];
      if (_selectedDevice != null &&
          !discovered.any((device) => device['id'] == _selectedDevice)) {
        _selectedDevice = null;
        _code.clear();
      }
      if (_loading ||
          _unsupported ||
          _error != null ||
          jsonEncode([status, devices, discovered]) !=
              jsonEncode([_status, _devices, _discovered])) {
        setState(() {
          _status = status;
          _devices = devices;
          _discovered = discovered;
          _loading = false;
          _unsupported = false;
          _error = null;
        });
      }
    } catch (error) {
      if (mounted && generation == _generation) {
        setState(() {
          _failed(error);
          _loading = false;
        });
      }
    } finally {
      _refreshing = false;
      _scheduleRefresh();
    }
  }

  Future<bool> _confirm(String title, String detail, String action) async =>
      await showAppDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: SizedBox(
            width: 360,
            child: Text(
              detail,
              style: TextStyle(
                fontFamily: grid.AppFont.sans,
                fontSize: 13.5,
                height: 1.4,
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              style: TextButton.styleFrom(
                foregroundColor: grid.AppPalette.textSecondary,
                overlayColor: grid.AppSurface.hoverFill,
              ),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const Key('device-confirm'),
              style: FilledButton.styleFrom(
                backgroundColor: grid.AppPalette.dangerFill,
                overlayColor: const Color(0x1FFFFFFF),
              ),
              onPressed: () => Navigator.pop(context, true),
              child: Text(action),
            ),
          ],
        ),
      ) ??
      false;

  Future<void> _act(Future<void> Function() action) async {
    if (_busy || (kUnderTest && widget.cli == null)) return;
    _timer?.cancel();
    // A poll begun before this mutation must not overwrite its newer response.
    _generation++;
    setState(() {
      _busy = true;
      _error = null;
      _actionError = null;
    });
    try {
      await action();
    } catch (error) {
      if (mounted) {
        setState(
          () => _actionError = error is AutonomousDeviceCliException
              ? error.userMessage
              : 'Could not reach the Harness CLI.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
      _scheduleRefresh();
    }
  }

  Future<void> _submitCode() async {
    final deviceId = _selectedDevice;
    final code = normalizeAutonomousDeviceCode(_code.text);
    if (_busy) return;
    if (deviceId == null ||
        !_discovered.any((device) => device['id'] == deviceId)) {
      setState(
        () => _actionError = 'Select your discovered Autonomous device first.',
      );
      return;
    }
    if (!RegExp(r'^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$').hasMatch(code)) {
      setState(
        () => _actionError =
            'Enter the six-character code shown on your Autonomous device.',
      );
      return;
    }
    await _act(() async {
      _code.clear();
      // The daemon resolves this selected discovery identity, never a UI address.
      await _cli.pair(code: code, deviceId: deviceId);
      if (mounted) {
        setState(() => _selectedDevice = null);
        // The pair response and the list row carry the same identity; reading
        // the list keeps one source for what is paired.
        final devices = await _cli.list();
        if (mounted) {
          setState(
            () => _devices = [
              for (final row in devices['devices'] as List? ?? [])
                if (row is Map<String, dynamic>) row,
            ],
          );
        }
      }
    });
  }

  Future<void> _revoke(Map<String, dynamic> device) async {
    if (!await _confirm(
      'Revoke Autonomous device?',
      'Disconnect ${device['label'] ?? 'this Autonomous device'} and remove its access to this computer. '
          'It will need to pair again.',
      'Revoke Autonomous device',
    )) {
      return;
    }
    if (!mounted) return;
    await _act(() async {
      await _cli.revoke(device['id'] as String);
      await _refresh();
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final disabled = _busy || _loading || (kUnderTest && widget.cli == null);
    Widget action(String label, VoidCallback? onPressed) => SizedBox(
      width: SettingRow.controlWidth,
      child: OutlinedButton(onPressed: onPressed, child: Text(label)),
    );
    return SectionScaffold(
      title: 'Autonomous devices',
      subtitle: 'Connect directly to your Autonomous device.',
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_loading)
              SkeletonBlock(
                child: Container(
                  decoration: BoxDecoration(
                    color: grid.AppGlass.surfaceFill,
                    borderRadius: BorderRadius.circular(14),
                    boxShadow: grid.AppGlass.cardShadow,
                  ),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 12,
                  ),
                  child: const SkeletonListTile(
                    leading: 0,
                    padding: EdgeInsets.zero,
                  ),
                ),
              ),
            if (_unsupported)
              SettingRow(
                title: 'Update Harness CLI to use Autonomous devices.',
                detail: 'Run this command in Terminal, then refresh this page.',
                control: SizedBox(
                  width: SettingRow.controlWidth,
                  child: Row(
                    children: [
                      const Expanded(child: SelectableText('harness update')),
                      AppIconButton(
                        icon: Icons.refresh_rounded,
                        tooltip: 'Refresh Autonomous device status',
                        onPressed: disabled
                            ? null
                            : () => unawaited(_refresh()),
                      ),
                    ],
                  ),
                ),
              ),
            if ((_actionError != null || _error != null) && !_unsupported)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  _actionError ?? _error!,
                  style: TextStyle(
                    fontFamily: grid.AppFont.sans,
                    fontSize: 13,
                    color: grid.AppPalette.dangerFill,
                  ),
                ),
              ),
            if (!_unsupported && !_loading) ...[
              for (final device in _devices) ...[
                SettingRow(
                  title: device['label']?.toString() ?? 'Autonomous device',
                  // The fingerprint belongs to the device it identifies, not to
                  // a row of its own two lines below it.
                  detail: [
                    device['pendingFirstSession'] == true
                        ? 'Waiting for first connection'
                        : device['online'] == true
                        ? 'Connected'
                        : 'Paired · Offline',
                    ?device['fingerprint']?.toString(),
                  ].join(' · '),
                  control: action(
                    'Revoke',
                    disabled || device['id'] is! String
                        ? null
                        : () => _revoke(device),
                  ),
                ),
                const SizedBox(height: 10),
              ],
              SettingRow(
                // The CLI's pair store is a map with no cap, so a paired device
                // is never replaced by the next one — say which act this is.
                title: _devices.isEmpty
                    ? 'Pair a device'
                    : 'Pair another device',
                alignTop: true,
                detail: _discovered.isEmpty
                    ? 'No Autonomous devices found. Keep your device on the same network, then refresh.'
                    : 'Select your device and enter its six-character code. Separators are allowed, for example ABC-123.',
                control: SizedBox(
                  width: SettingRow.controlWidth,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: IgnorePointer(
                              ignoring: disabled,
                              child: AppSelectField<String?>(
                                key: const Key('autonomous-device-selection'),
                                value: _selectedDevice,
                                options: [
                                  const SelectOption<String?>(
                                    value: null,
                                    label: 'Select a device',
                                  ),
                                  for (final device in _discovered)
                                    SelectOption<String?>(
                                      value: device['id'] as String,
                                      label:
                                          device['name']?.toString() ??
                                          'Autonomous device',
                                    ),
                                ],
                                onChanged: (value) => setState(() {
                                  _selectedDevice = value;
                                  _code.clear();
                                  _actionError = null;
                                }),
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          AppIconButton(
                            icon: Icons.refresh_rounded,
                            tooltip: 'Refresh Autonomous device status',
                            onPressed: disabled
                                ? null
                                : () => unawaited(_refresh()),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      TextField(
                        key: const Key('autonomous-device-code'),
                        controller: _code,
                        enabled: !disabled,
                        maxLength: 32,
                        obscureText: true,
                        autocorrect: false,
                        enableSuggestions: false,
                        style: TextStyle(
                          fontFamily: grid.AppFont.sans,
                          fontSize: 13,
                          color: grid.AppPalette.textPrimary,
                        ),
                        decoration: labeledFieldDecoration(
                          'Six-character code',
                          fill: grid.AppCard.inset,
                        ).copyWith(counterText: ''),
                        onSubmitted: (_) => unawaited(_submitCode()),
                      ),
                      const SizedBox(height: 10),
                      action(
                        _busy ? 'Pairing…' : 'Pair',
                        disabled ? null : () => unawaited(_submitCode()),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 10),
              Text(
                'Harness CLI keeps the connection running when you close Desktop.',
                style: TextStyle(
                  fontFamily: grid.AppFont.sans,
                  fontSize: 12,
                  color: grid.AppPalette.textSecondary,
                ),
              ),
              const SizedBox(height: 10),
            ],
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}
