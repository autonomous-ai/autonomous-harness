import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

class EngineIdentity {
  final String id;
  final String label;
  final Color color;
  final String? asset;

  const EngineIdentity({
    required this.id,
    required this.label,
    required this.color,
    this.asset,
  });
}

const _engines = <String, EngineIdentity>{
  'claude': EngineIdentity(
    id: 'claude',
    label: 'Claude',
    color: Color(0xffcc7c5e),
  ),
  'codex': EngineIdentity(
    id: 'codex',
    label: 'Codex',
    color: Color(0xff64d2ff),
    asset: 'assets/engine-icons/codex.png',
  ),
  'cursor': EngineIdentity(
    id: 'cursor',
    label: 'Cursor',
    color: Color(0xffc6ff72),
    asset: 'assets/engine-icons/cursor.png',
  ),
  'opencode': EngineIdentity(
    id: 'opencode',
    label: 'OpenCode',
    color: Color(0xfff1ecec),
    asset: 'assets/engine-icons/opencode.png',
  ),
  'pi': EngineIdentity(
    id: 'pi',
    label: 'Pi',
    color: Colors.white,
    asset: 'assets/engine-icons/pi.png',
  ),
  'hermes': EngineIdentity(
    id: 'hermes',
    label: 'Hermes',
    color: Color(0xff9b8cff),
    asset: 'assets/engine-icons/hermes.png',
  ),
  'commandcode': EngineIdentity(
    id: 'commandcode',
    label: 'Command Code',
    color: Color(0xfff5f5f5),
    asset: 'assets/engine-icons/commandcode.png',
  ),
  'devin': EngineIdentity(
    id: 'devin',
    label: 'Devin',
    color: Color(0xff8fb8ff),
    asset: 'assets/engine-icons/devin.png',
  ),
  'muse': EngineIdentity(
    id: 'muse',
    label: 'Muse',
    color: Color(0xff0082fb),
    asset: 'assets/engine-icons/muse.png',
  ),
  'amp': EngineIdentity(
    id: 'amp',
    label: 'Amp',
    color: Color(0xfff34e3f),
    asset: 'assets/engine-icons/amp.png',
  ),
  'kilo': EngineIdentity(
    id: 'kilo',
    label: 'Kilo',
    color: Color(0xfff8f676),
    asset: 'assets/engine-icons/kilo.png',
  ),
  'grok': EngineIdentity(
    id: 'grok',
    label: 'Grok',
    color: Colors.white,
    asset: 'assets/engine-icons/grok.png',
  ),
  'copilot': EngineIdentity(
    id: 'copilot',
    label: 'Copilot',
    color: Color(0xff8957e5),
    asset: 'assets/engine-icons/copilot.png',
  ),
  'agy': EngineIdentity(
    id: 'agy',
    label: 'Antigravity',
    color: Color(0xff3287fb),
    asset: 'assets/engine-icons/agy.png',
  ),
};

/// All known engines, in declaration order — for the New Agent engine picker.
List<EngineIdentity> get allEngines => _engines.values.toList(growable: false);

EngineIdentity engineIdentity(String? engine, {String? displayName}) {
  final id = engine?.trim().toLowerCase() ?? '';
  final known = _engines[id];
  if (known != null) return known;
  final raw = displayName?.trim().isNotEmpty == true
      ? displayName!.trim()
      : id.isEmpty
      ? 'Agent'
      : id;
  final label = raw[0].toUpperCase() + raw.substring(1);
  return EngineIdentity(
    id: id.isEmpty ? 'unknown' : id,
    label: label,
    color: AppColors.mutedStrong,
  );
}

class EngineMark extends StatelessWidget {
  final String? engine;
  final String? displayName;
  final bool enabled;
  final double size;

  const EngineMark({
    super.key,
    required this.engine,
    this.displayName,
    this.enabled = true,
    this.size = 16,
  });

  @override
  Widget build(BuildContext context) {
    final identity = engineIdentity(engine, displayName: displayName);
    final mark = identity.asset != null
        ? Image.asset(
            identity.asset!,
            key: ValueKey('engine-icon-${identity.id}'),
            width: size,
            height: size,
            fit: BoxFit.contain,
            filterQuality: FilterQuality.high,
            errorBuilder: (_, _, _) => _InitialMark(
              key: ValueKey('engine-fallback-${identity.id}'),
              identity: identity,
              size: size,
            ),
          )
        : identity.id == 'claude'
        ? CustomPaint(
            key: const ValueKey('engine-icon-claude'),
            size: Size.square(size),
            painter: _ClaudeMarkPainter(identity.color),
          )
        : _InitialMark(
            key: ValueKey('engine-fallback-${identity.id}'),
            identity: identity,
            size: size,
          );
    return Opacity(opacity: enabled ? 1 : 0.45, child: mark);
  }
}

class _InitialMark extends StatelessWidget {
  final EngineIdentity identity;
  final double size;

  const _InitialMark({super.key, required this.identity, required this.size});

  @override
  Widget build(BuildContext context) {
    return SizedBox.square(
      dimension: size,
      child: Center(
        child: Text(
          identity.label.characters.first.toUpperCase(),
          // ⚠️ Sized from [size], a FIXED box, not from the type ramp — so it
          // must not take the app's UI scale either. At the top of the range the
          // glyph would grow while its 17px square did not, and the letter would
          // clip out of its own mark.
          textScaler: TextScaler.noScaling,
          style: TextStyle(
            color: identity.color,
            // The app's mono stack, not a literal: `Menlo` names nothing on
            // Linux, so this initial was drawn in the proportional default
            // while every mark beside it was monospaced.
            fontFamily: AppFonts.mono,
            fontFamilyFallback: AppFonts.monoFallback,
            fontSize: size * 0.68,
            height: 1,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }
}

class _ClaudeMarkPainter extends CustomPainter {
  final Color color;
  const _ClaudeMarkPainter(this.color);

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = size.width * 0.098
      ..strokeCap = StrokeCap.round;
    final c = Offset(size.width / 2, size.height / 2);
    final radius = size.width * 0.39;
    for (var i = 0; i < 4; i++) {
      final angle = i * 0.78539816339;
      final dx = radius * math.cos(angle);
      final dy = radius * math.sin(angle);
      canvas.drawLine(c - Offset(dx, dy), c + Offset(dx, dy), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _ClaudeMarkPainter oldDelegate) =>
      oldDelegate.color != color;
}
