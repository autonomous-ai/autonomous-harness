import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../flash/flasher.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';

/// Writes firmware to the plugged-in dial, and shows the flasher's own output
/// while it happens.
Future<void> showFlashFirmwareDialog(BuildContext context, {Flasher? flasher}) {
  return showAppDialog<void>(
    context: context,
    // A half-written image is a board that will not boot. The dialog refuses to
    // leave while the write is in flight; PopScope below does the same for the
    // Escape key and the window's own close.
    barrierDismissible: false,
    builder: (context) => _FlashDialog(flasher: flasher ?? Flasher()),
  );
}

enum _Phase { probing, ready, noBoard, flashing, done, failed }

class _FlashDialog extends StatefulWidget {
  const _FlashDialog({required this.flasher});

  final Flasher flasher;

  @override
  State<_FlashDialog> createState() => _FlashDialogState();
}

class _FlashDialogState extends State<_FlashDialog> {
  final List<FlashLine> _log = [];
  final ScrollController _logScroll = ScrollController();

  _Phase _phase = _Phase.probing;
  List<String> _ports = const [];
  String? _port;
  String? _problem;

  /// Step titles in the order the script announced them, and which one is live.
  final List<String> _steps = [];
  bool _stepFailed = false;

  Stopwatch? _elapsed;
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    unawaited(_probe());
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _logScroll.dispose();
    super.dispose();
  }

  Future<void> _probe() async {
    setState(() {
      _phase = _Phase.probing;
      _log.clear();
      _steps.clear();
      _problem = null;
    });
    final probe = await widget.flasher.probe();
    if (!mounted) return;
    setState(() {
      _log
        ..clear()
        ..addAll(probe.log);
      _ports = probe.ports;
      _port = probe.ports.length == 1 ? probe.ports.first : null;
      _problem = probe.problem;
      _phase = probe.found ? _Phase.ready : _Phase.noBoard;
    });
  }

  Future<void> _flash() async {
    setState(() {
      _phase = _Phase.flashing;
      _log.clear();
      _steps.clear();
      _stepFailed = false;
      _problem = null;
      _elapsed = Stopwatch()..start();
    });
    _ticker = Timer.periodic(
      const Duration(seconds: 1),
      (_) => mounted ? setState(() {}) : null,
    );

    final result = await widget.flasher.flash(port: _port, onLine: _onLine);
    _ticker?.cancel();
    _elapsed?.stop();
    if (!mounted) return;
    setState(() {
      if (!result.ok) _stepFailed = true;
      _phase = result.ok ? _Phase.done : _Phase.failed;
      if (!result.ok) {
        _problem = result.cancelled
            ? 'Stopped. Harness has been started again.'
            : _lastTrouble() ?? 'The flasher exited with ${result.exitCode}.';
      }
    });
  }

  void _onLine(FlashLine line) {
    if (!mounted) return;
    setState(() {
      _log.add(line);
      if (line.kind == FlashLineKind.step) _steps.add(line.title);
    });
    // Follow the tail the way a terminal does.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_logScroll.hasClients) {
        _logScroll.jumpTo(_logScroll.position.maxScrollExtent);
      }
    });
  }

  String? _lastTrouble() {
    for (final line in _log.reversed) {
      if (line.kind == FlashLineKind.error ||
          line.kind == FlashLineKind.warning) {
        return line.text.trim().replaceFirst(RegExp(r'^error:\s*'), '');
      }
    }
    return null;
  }

  /// The version the script said it wrote, once it has said so.
  String? get _version {
    for (final line in _log) {
      final match = RegExp(r'^>> release: \S+ (\S+)').firstMatch(line.text);
      if (match != null) return match.group(1);
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return PopScope(
      canPop: _phase != _Phase.flashing,
      child: Dialog(
        // See the note on the other two dialogs: `dialogTheme` owns the
        // fill, the radius and the absence of a rim.
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 540),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 17, 18, 0),
                child: _header(),
              ),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(18, 14, 18, 0),
                  child: _body(),
                ),
              ),
              _actions(),
            ],
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- header

  Widget _header() {
    final (
      IconData? icon,
      Color tone,
      String title,
      String sub,
    ) = switch (_phase) {
      _Phase.probing => (
        null,
        grid.AppPalette.accentOnSurface,
        'Looking for the dial…',
        'Checking the USB ports on this Mac.',
      ),
      _Phase.ready => (
        LucideIcons.zap300,
        grid.AppPalette.accentOnSurface,
        'Flash firmware to the dial',
        'Writes the latest circle release over USB.',
      ),
      _Phase.noBoard => (
        LucideIcons.usb300,
        grid.AppPalette.warn,
        'No dial found',
        _problem ??
            'Plug the dial into this Mac with a USB cable, then look '
                'again.',
      ),
      _Phase.flashing => (
        null,
        grid.AppPalette.accentOnSurface,
        _version == null
            ? 'Flashing the dial…'
            : 'Flashing $_version → ${_port ?? 'the dial'}',
        'Don’t unplug the dial.',
      ),
      _Phase.done => (
        LucideIcons.circleCheck300,
        grid.AppPalette.online,
        _version == null
            ? 'The dial is flashed'
            : 'circle $_version is on the dial',
        'Harness is running again. Your machines are back.',
      ),
      _Phase.failed => (
        LucideIcons.triangleAlert300,
        grid.AppPalette.dangerFill,
        'Flash failed',
        _problem ?? 'Nothing else was changed. Harness has been started again.',
      ),
    };

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(
            color: tone.withValues(alpha: 0.13),
            borderRadius: BorderRadius.circular(grid.AppCard.insetRadius),
          ),
          alignment: Alignment.center,
          child: icon == null
              ? SizedBox(
                  width: 17,
                  height: 17,
                  child: CircularProgressIndicator(strokeWidth: 2, color: tone),
                )
              : Icon(icon, size: 18, color: tone),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: TextStyle(
                  color: grid.AppPalette.textPrimary,
                  fontSize: 15,
                  fontWeight: grid.AppFont.semibold,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                sub,
                style: TextStyle(
                  color: grid.AppPalette.textSecondary,
                  fontSize: 12.5,
                  height: 1.5,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  // ------------------------------------------------------------------ body

  Widget _body() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_phase == _Phase.ready) ...[
          _facts(),
          if (_ports.length > 1) _portPicker(),
          _daemonNotice(),
        ],
        if (_phase == _Phase.done) _facts(),
        if (_phase == _Phase.flashing || _phase == _Phase.failed) ...[
          _stepList(),
          if (_phase == _Phase.flashing) ...[
            const SizedBox(height: 13),
            // Indeterminate on purpose. esptool prints a percentage, but it is
            // the percentage of ONE write — following it would run the bar to
            // full and drop it back to zero several times over.
            LinearProgressIndicator(
              minHeight: 2,
              backgroundColor: grid.AppGlass.hair,
              color: grid.AppPalette.accentOnSurface,
            ),
          ],
        ],
        if (_log.isNotEmpty && _phase != _Phase.ready) _logPane(),
      ],
    );
  }

  Widget _facts() {
    final done = _phase == _Phase.done;
    return Column(
      children: [
        _fact('Board', _port ?? 'the dial'),
        const SizedBox(height: 7),
        if (done) ...[
          _fact('Flashed', _version ?? 'circle'),
          const SizedBox(height: 7),
          _fact('Took', _formatElapsed(), tone: grid.AppPalette.textSecondary),
        ] else
          // Not a version number: --detect-only returns before the script
          // resolves the release, so nothing here knows it yet, and inventing
          // one would be a guess presented as a fact.
          _fact('Will install', 'circle · latest'),
      ],
    );
  }

  Widget _fact(String label, String value, {Color? tone}) {
    grid.AppTheme.watch(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 104,
          child: Text(
            label,
            style: TextStyle(color: grid.AppPalette.textFaint, fontSize: 11.5),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: TextStyle(
              color: tone ?? grid.AppPalette.textSecondary,
              fontSize: 11.5,
              fontFamily: grid.AppFont.mono,
              fontFamilyFallback: grid.AppFont.monoFallback,
            ),
          ),
        ),
      ],
    );
  }

  Widget _portPicker() {
    return Padding(
      padding: const EdgeInsets.only(top: 13),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'More than one board is connected — pick one:',
            style: TextStyle(
              color: grid.AppPalette.textSecondary,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 7),
          for (final port in _ports)
            _PortChoice(
              port: port,
              selected: port == _port,
              onTap: () => setState(() => _port = port),
            ),
        ],
      ),
    );
  }

  Widget _daemonNotice() {
    return Container(
      margin: const EdgeInsets.only(top: 13),
      padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
      decoration: BoxDecoration(
        color: grid.AppPalette.warn.withValues(alpha: 0.09),
        border: Border.all(color: grid.AppPalette.warn.withValues(alpha: 0.24)),
        borderRadius: BorderRadius.circular(grid.AppCard.insetRadius),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            LucideIcons.triangleAlert300,
            size: 14,
            color: grid.AppPalette.warn,
          ),
          const SizedBox(width: 9),
          Expanded(
            child: RichText(
              text: TextSpan(
                style: TextStyle(
                  color: grid.AppPalette.textSecondary,
                  fontSize: 11.5,
                  height: 1.5,
                ),
                children: [
                  TextSpan(
                    text: 'Harness stops while flashing. ',
                    style: TextStyle(
                      color: grid.AppPalette.textPrimary,
                      fontWeight: grid.AppFont.semibold,
                    ),
                  ),
                  const TextSpan(
                    text:
                        'The flasher has to close the serial port, so your '
                        'machines go offline for about a minute and come back '
                        'on their own.',
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _stepList() {
    return Column(
      children: [
        for (var i = 0; i < _steps.length; i++)
          _StepRow(
            label: _steps[i],
            state: i < _steps.length - 1
                ? _StepState.done
                : _stepFailed
                ? _StepState.failed
                : _phase == _Phase.flashing
                ? _StepState.running
                : _StepState.done,
          ),
      ],
    );
  }

  Widget _logPane() {
    return Container(
      margin: const EdgeInsets.only(top: 13),
      decoration: BoxDecoration(
        border: Border.all(color: grid.AppGlass.hair),
        borderRadius: BorderRadius.circular(grid.AppCard.insetRadius),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          Container(
            padding: const EdgeInsets.fromLTRB(10, 7, 10, 7),
            color: grid.AppPalette.windowBg,
            child: Row(
              children: [
                Icon(
                  LucideIcons.squareTerminal300,
                  size: 13,
                  color: grid.AppPalette.textFaint,
                ),
                const SizedBox(width: 8),
                Text(
                  'Output',
                  style: TextStyle(
                    color: grid.AppPalette.textSecondary,
                    fontSize: 11.5,
                  ),
                ),
                const Spacer(),
                Text(
                  'flash-circle.sh',
                  style: TextStyle(
                    color: grid.AppPalette.textFaint,
                    fontSize: 11.5,
                  ),
                ),
              ],
            ),
          ),
          Container(
            constraints: const BoxConstraints(maxHeight: 170),
            width: double.infinity,
            color: grid.AppPalette.windowBg,
            child: SingleChildScrollView(
              controller: _logScroll,
              padding: const EdgeInsets.fromLTRB(11, 9, 11, 9),
              child: SelectableText.rich(
                TextSpan(
                  children: [
                    for (final line in _log)
                      TextSpan(
                        text: '${line.text}\n',
                        style: TextStyle(color: _inkFor(line.kind)),
                      ),
                  ],
                ),
                style: TextStyle(
                  fontSize: 11,
                  height: 1.62,
                  fontFamily: grid.AppFont.mono,
                  fontFamilyFallback: grid.AppFont.monoFallback,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Color _inkFor(FlashLineKind kind) => switch (kind) {
    FlashLineKind.step => grid.AppPalette.textPrimary,
    FlashLineKind.detail => grid.AppPalette.textSecondary,
    FlashLineKind.warning => grid.AppPalette.warn,
    FlashLineKind.error => grid.AppPalette.dangerFill,
  };

  // --------------------------------------------------------------- actions

  Widget _actions() {
    final children = <Widget>[];

    if (_log.isNotEmpty && _phase != _Phase.probing) {
      children.add(
        _DialogButton(
          label: 'Copy log',
          onPressed: () => unawaited(
            Clipboard.setData(
              ClipboardData(text: _log.map((l) => l.text).join('\n')),
            ),
          ),
        ),
      );
    }
    children.add(const Spacer());

    switch (_phase) {
      case _Phase.probing:
        children.add(
          _DialogButton(
            label: 'Cancel',
            onPressed: () => Navigator.pop(context),
          ),
        );
      case _Phase.ready:
        children
          ..add(
            _DialogButton(
              label: 'Cancel',
              kind: _ButtonKind.ghost,
              onPressed: () => Navigator.pop(context),
            ),
          )
          ..add(const SizedBox(width: 8))
          ..add(
            _DialogButton(
              key: const Key('flash-start-button'),
              label: 'Flash',
              kind: _ButtonKind.primary,
              // The script asks for confirmation on a terminal it does not
              // have here, so it runs with --yes. THIS is the confirmation.
              onPressed: _port == null && _ports.length > 1
                  ? null
                  : () => unawaited(_flash()),
            ),
          );
      case _Phase.noBoard:
        children
          ..add(
            _DialogButton(
              label: 'Close',
              kind: _ButtonKind.ghost,
              onPressed: () => Navigator.pop(context),
            ),
          )
          ..add(const SizedBox(width: 8))
          ..add(
            _DialogButton(
              label: 'Look again',
              kind: _ButtonKind.primary,
              onPressed: () => unawaited(_probe()),
            ),
          );
      case _Phase.flashing:
        children.add(
          _DialogButton(
            key: const Key('flash-stop-button'),
            label: 'Stop',
            kind: _ButtonKind.ghost,
            onPressed: widget.flasher.cancel,
          ),
        );
      case _Phase.done:
        children.add(
          _DialogButton(
            label: 'Done',
            kind: _ButtonKind.primary,
            onPressed: () => Navigator.pop(context),
          ),
        );
      case _Phase.failed:
        children
          ..add(
            _DialogButton(
              label: 'Close',
              kind: _ButtonKind.ghost,
              onPressed: () => Navigator.pop(context),
            ),
          )
          ..add(const SizedBox(width: 8))
          ..add(
            _DialogButton(
              label: 'Try again',
              kind: _ButtonKind.primary,
              onPressed: () => unawaited(_flash()),
            ),
          );
    }

    return Container(
      margin: const EdgeInsets.only(top: 14),
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 12),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: grid.AppGlass.hair)),
      ),
      child: Row(children: children),
    );
  }

  String _formatElapsed() {
    final seconds = (_elapsed?.elapsed.inSeconds ?? 0);
    final minutes = seconds ~/ 60;
    return '$minutes:${(seconds % 60).toString().padLeft(2, '0')}';
  }
}

enum _StepState { done, running, failed }

class _StepRow extends StatelessWidget {
  const _StepRow({required this.label, required this.state});

  final String label;
  final _StepState state;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final (Widget mark, Color ink) = switch (state) {
      _StepState.done => (
        Icon(
          LucideIcons.circleCheck300,
          size: 14,
          color: grid.AppPalette.online,
        ),
        grid.AppPalette.textSecondary,
      ),
      _StepState.running => (
        SizedBox(
          width: 13,
          height: 13,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: grid.AppPalette.accentOnSurface,
          ),
        ),
        grid.AppPalette.textPrimary,
      ),
      _StepState.failed => (
        Icon(
          LucideIcons.triangleAlert300,
          size: 14,
          color: grid.AppPalette.dangerFill,
        ),
        grid.AppPalette.textPrimary,
      ),
    };

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox(width: 16, child: Center(child: mark)),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: ink, fontSize: 12.5),
            ),
          ),
        ],
      ),
    );
  }
}

enum _ButtonKind { quiet, ghost, primary }

class _DialogButton extends StatelessWidget {
  const _DialogButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.kind = _ButtonKind.quiet,
  });

  final String label;
  final VoidCallback? onPressed;
  final _ButtonKind kind;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final primary = kind == _ButtonKind.primary;
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        minimumSize: const Size(0, 28),
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 5),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        visualDensity: VisualDensity.standard,
        backgroundColor: primary
            ? grid.AppPalette.accentOnSurface
            : Colors.transparent,
        foregroundColor: primary
            ? grid.AppPalette.windowBg
            : grid.AppPalette.textSecondary,
        disabledForegroundColor: grid.AppPalette.textFaint,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(7),
          side: kind == _ButtonKind.ghost
              ? BorderSide(color: grid.AppGlass.hair)
              : BorderSide.none,
        ),
        textStyle: TextStyle(
          fontSize: 12,
          fontWeight: primary ? grid.AppFont.semibold : grid.AppFont.regular,
        ),
      ),
      child: Text(label),
    );
  }
}

/// One selectable serial port, when more than one board is plugged in.
class _PortChoice extends StatelessWidget {
  const _PortChoice({
    required this.port,
    required this.selected,
    required this.onTap,
  });

  final String port;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final accent = grid.AppPalette.accentOnSurface;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(7),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: Row(
          children: [
            Container(
              width: 13,
              height: 13,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(
                  color: selected ? accent : grid.AppPalette.textFaint,
                  width: 1.5,
                ),
              ),
              alignment: Alignment.center,
              child: selected
                  ? Container(
                      width: 6,
                      height: 6,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: accent,
                      ),
                    )
                  : null,
            ),
            const SizedBox(width: 9),
            Text(
              port,
              style: TextStyle(
                color: grid.AppPalette.textPrimary,
                fontSize: 12,
                fontFamily: grid.AppFont.mono,
                fontFamilyFallback: grid.AppFont.monoFallback,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
