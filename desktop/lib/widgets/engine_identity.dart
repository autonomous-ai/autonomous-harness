import 'dart:math' as math;


import 'package:flutter/material.dart';

import '../core/models.dart';
import '../theme/app_theme.dart';

class EngineIdentity {
  final String id;
  final String label;
  final Color color;
  final String? asset;

  /// The kind of thing it makes, in a word or two — "Code" for every coding
  /// engine, "PCB", "3D design", "Slides" for the harnesses. The picker's
  /// second line under the name, so a name with some character never has to
  /// explain itself.
  final String? category;

  /// Who made the agent — "Anthropic", "OpenAI", "Autonomous" for the org's own
  /// packages, "Jake Fitzgerald" for text-to-cad. The picker shows it beside
  /// the category so the tile says what it makes and whose it is.
  final String? creator;

  /// The vendor's page for it — the store's Website link. Null when there is
  /// no page worth sending someone to.
  final String? homepage;

  /// One sentence for the store card: what it is, whose it is.
  final String? blurb;

  const EngineIdentity({
    required this.id,
    required this.label,
    required this.color,
    this.asset,
    this.category,
    this.creator,
    this.homepage,
    this.blurb,
  });

  /// "Code · OpenAI", "CAD · Jake Fitzgerald" — the tile's second line.
  String? get detail {
    final parts = [category, creator].whereType<String>().where((s) => s.isNotEmpty);
    return parts.isEmpty ? null : parts.join(' · ');
  }
}

const _engines = <String, EngineIdentity>{
  'claude': EngineIdentity(
    id: 'claude',
    label: 'Claude',
    category: 'Code',
    creator: 'Anthropic',
    color: Color(0xffcc7c5e),
    homepage: 'https://claude.com/product/claude-code',
    blurb: "Anthropic's agentic coding tool in the terminal: reads the codebase, edits, runs tests, opens pull requests.",
  ),
  'codex': EngineIdentity(
    id: 'codex',
    label: 'Codex',
    category: 'Code',
    creator: 'OpenAI',
    color: Color(0xff64d2ff),
    asset: 'assets/engine-icons/codex.png',
    homepage: 'https://github.com/openai/codex',
    blurb: "OpenAI's coding agent for the terminal, on the Codex models.",
  ),
  'cursor': EngineIdentity(
    id: 'cursor',
    label: 'Cursor',
    category: 'Code',
    creator: 'Anysphere',
    color: Color(0xffc6ff72),
    asset: 'assets/engine-icons/cursor.png',
    homepage: 'https://cursor.com/cli',
    blurb: "Cursor's agent in the terminal — the same agent as in the editor.",
  ),
  'opencode': EngineIdentity(
    id: 'opencode',
    label: 'OpenCode',
    category: 'Code',
    creator: 'Anomaly',
    color: Color(0xfff1ecec),
    asset: 'assets/engine-icons/opencode.png',
    homepage: 'https://opencode.ai',
    blurb: "An open-source coding agent for the terminal that works with any model.",
  ),
  'pi': EngineIdentity(
    id: 'pi',
    label: 'Pi',
    category: 'Code',
    creator: 'pi.dev',
    color: Colors.white,
    asset: 'assets/engine-icons/pi.png',
    homepage: 'https://pi.dev',
    blurb: "A small, extensible coding agent for the terminal.",
  ),
  'hermes': EngineIdentity(
    id: 'hermes',
    label: 'Hermes',
    category: 'Code',
    creator: 'Nous Research',
    color: Color(0xff9b8cff),
    asset: 'assets/engine-icons/hermes.png',
    homepage: 'https://github.com/NousResearch/hermes-agent',
    blurb: "Nous Research's open agent with memory and skills, in the terminal.",
  ),
  'commandcode': EngineIdentity(
    id: 'commandcode',
    label: 'Command Code',
    category: 'Code',
    creator: 'Command Code',
    color: Color(0xfff5f5f5),
    asset: 'assets/engine-icons/commandcode.png',
    blurb: "Command Code's coding agent for the terminal.",
  ),
  'devin': EngineIdentity(
    id: 'devin',
    label: 'Devin',
    category: 'Code',
    creator: 'Cognition',
    color: Color(0xff8fb8ff),
    asset: 'assets/engine-icons/devin.png',
    homepage: 'https://devin.ai',
    blurb: "Cognition's Devin, as an agent in the terminal.",
  ),
  'muse': EngineIdentity(
    id: 'muse',
    label: 'Muse',
    category: 'Code',
    creator: 'Meta',
    color: Color(0xff0082fb),
    asset: 'assets/engine-icons/muse.png',
    blurb: "Meta's coding agent for the terminal.",
  ),
  'amp': EngineIdentity(
    id: 'amp',
    label: 'Amp',
    category: 'Code',
    creator: 'Sourcegraph',
    color: Color(0xfff34e3f),
    asset: 'assets/engine-icons/amp.png',
    homepage: 'https://ampcode.com',
    blurb: "Sourcegraph's agentic coding tool.",
  ),
  'kilo': EngineIdentity(
    id: 'kilo',
    label: 'Kilo',
    category: 'Code',
    creator: 'Kilo Code',
    color: Color(0xfff8f676),
    asset: 'assets/engine-icons/kilo.png',
    homepage: 'https://kilocode.ai',
    blurb: "Kilo Code's open-source coding agent.",
  ),
  'grok': EngineIdentity(
    id: 'grok',
    label: 'Grok',
    category: 'Code',
    creator: 'xAI',
    color: Colors.white,
    asset: 'assets/engine-icons/grok.png',
    homepage: 'https://x.ai',
    blurb: "xAI's Grok as a coding agent in the terminal.",
  ),
  'copilot': EngineIdentity(
    id: 'copilot',
    label: 'Copilot',
    category: 'Code',
    creator: 'GitHub',
    color: Color(0xff8957e5),
    asset: 'assets/engine-icons/copilot.png',
    homepage: 'https://github.com/github/copilot-cli',
    blurb: "GitHub Copilot's coding agent in the terminal.",
  ),
  'agy': EngineIdentity(
    id: 'agy',
    label: 'Antigravity',
    category: 'Code',
    creator: 'Google',
    color: Color(0xff3287fb),
    asset: 'assets/engine-icons/agy.png',
    homepage: 'https://antigravity.google',
    blurb: "Google's Antigravity agent in the terminal.",
  ),
};

/// The domain-specific harnesses this build has a picture of, keyed by their
/// `owner/name` id — the same id the daemon puts on the wire as `dsh`.
///
/// A SEPARATE map from [_engines], and deliberately not part of [allEngines]:
/// a harness runs ON one of those engines rather than beside them, so it must
/// never be probed as one (`engines_probe`) or offered a bypass flag of its
/// own. It is only a face. A harness absent here still draws — the daemon
/// sends its name, and [engineIdentity] falls back to an initial.
const _harnesses = <String, EngineIdentity>{
  'autonomous/autonomous-circuit': EngineIdentity(
    id: 'autonomous/autonomous-circuit',
    label: 'Autonomous Circuit',
    category: 'PCB',
    creator: 'Autonomous',
    color: Color(0xffd98a4a),
    asset: 'assets/engine-icons/autonomous-circuit.png',
  ),
  'autonomous/autonomous-workshop': EngineIdentity(
    id: 'autonomous/autonomous-workshop',
    label: 'Autonomous Workshop',
    category: 'CAD',
    creator: 'Autonomous',
    color: Color(0xff5a52d8),
    asset: 'assets/engine-icons/autonomous-workshop.png',
  ),
  'autonomous/marp': EngineIdentity(
    id: 'autonomous/marp',
    label: 'Marp',
    category: 'Slides',
    creator: 'Yuki Hattori',
    color: Color(0xff218cdb),
    asset: 'assets/engine-icons/marp.png',
  ),
  'autonomous/text-to-cad': EngineIdentity(
    id: 'autonomous/text-to-cad',
    label: 'text-to-cad',
    category: 'CAD',
    creator: 'Jake Fitzgerald',
    color: Color(0xff3aa0e0),
    asset: 'assets/engine-icons/text-to-cad.png',
  ),
  // The store's first wave: open-source projects under their own names, their
  // makers on the tile (store/README.md "Stewardship").
  'autonomous/typst': EngineIdentity(
    id: 'autonomous/typst',
    label: 'Typst',
    category: 'Documents',
    creator: 'Typst GmbH',
    color: Color(0xff239dad),
    asset: 'assets/engine-icons/typst.png',
  ),
  'autonomous/manim': EngineIdentity(
    id: 'autonomous/manim',
    label: 'Manim',
    category: 'Math animation',
    creator: 'Manim Community',
    color: Color(0xffe0a458),
    asset: 'assets/engine-icons/manim.png',
  ),
  'autonomous/excalidraw': EngineIdentity(
    id: 'autonomous/excalidraw',
    label: 'Excalidraw',
    category: 'Diagrams',
    creator: 'Excalidraw',
    color: Color(0xff6965db),
    asset: 'assets/engine-icons/excalidraw.png',
  ),
  'autonomous/marimo': EngineIdentity(
    id: 'autonomous/marimo',
    label: 'marimo',
    category: 'Notebooks',
    creator: 'marimo',
    color: Color(0xff1c7c54),
    asset: 'assets/engine-icons/marimo.png',
  ),
  'autonomous/remotion': EngineIdentity(
    id: 'autonomous/remotion',
    label: 'Remotion',
    category: 'Video',
    creator: 'Remotion',
    color: Color(0xff0b84f3),
    asset: 'assets/engine-icons/remotion.png',
  ),
  'autonomous/blender': EngineIdentity(
    id: 'autonomous/blender',
    label: 'Blender',
    category: '3D',
    creator: 'Blender Foundation',
    color: Color(0xffe87d0d),
    asset: 'assets/engine-icons/blender.png',
  ),
  'autonomous/mujoco': EngineIdentity(
    id: 'autonomous/mujoco',
    label: 'MuJoCo',
    category: 'Simulation',
    creator: 'Google DeepMind',
    color: Color(0xff1b2a6b),
    asset: 'assets/engine-icons/mujoco.png',
  ),
  'autonomous/phaser': EngineIdentity(
    id: 'autonomous/phaser',
    label: 'Phaser',
    category: 'Games',
    creator: 'Phaser Studio',
    color: Color(0xff2a5bd7),
    asset: 'assets/engine-icons/phaser.png',
  ),
  'autonomous/strudel': EngineIdentity(
    id: 'autonomous/strudel',
    label: 'Strudel',
    category: 'Music',
    creator: 'Strudel',
    color: Color(0xffe0577b),
    asset: 'assets/engine-icons/strudel.png',
  ),
  'autonomous/rdkit': EngineIdentity(
    id: 'autonomous/rdkit',
    label: 'RDKit',
    category: 'Chemistry',
    creator: 'RDKit',
    color: Color(0xff1d7bb8),
    asset: 'assets/engine-icons/rdkit.png',
  ),
  'autonomous/yosys': EngineIdentity(
    id: 'autonomous/yosys',
    label: 'Yosys',
    category: 'Chips',
    creator: 'YosysHQ',
    color: Color(0xff2f7d5b),
    asset: 'assets/engine-icons/yosys.png',
  ),
  'autonomous/circuitjs': EngineIdentity(
    id: 'autonomous/circuitjs',
    label: 'CircuitJS',
    category: 'Circuits',
    creator: 'Paul Falstad',
    color: Color(0xff50fa78),
    asset: 'assets/engine-icons/circuitjs.png',
  ),
};

/// The base engine each first-party harness runs on, so the Create dialog can
/// say "Runs on Claude Code" — and send the right `engine` — before the machine
/// has answered `dsh_list`. The daemon's catalog is authoritative when present.
const knownHarnessBase = <String, String>{
  'autonomous/autonomous-circuit': 'claude',
  'autonomous/autonomous-workshop': 'codex',
  'autonomous/marp': 'claude',
  'autonomous/text-to-cad': 'claude',
  'autonomous/typst': 'claude',
  'autonomous/manim': 'claude',
  'autonomous/excalidraw': 'claude',
  'autonomous/marimo': 'claude',
  'autonomous/remotion': 'claude',
  'autonomous/blender': 'claude',
  'autonomous/mujoco': 'claude',
  'autonomous/phaser': 'codex',
  'autonomous/strudel': 'claude',
  'autonomous/rdkit': 'codex',
  'autonomous/yosys': 'claude',
  'autonomous/circuitjs': 'codex',
};

/// All known engines, in declaration order — for the New Agent engine picker.
List<EngineIdentity> get allEngines => _engines.values.toList(growable: false);

/// The harnesses this build ships a face for, in declaration order.
List<EngineIdentity> get knownHarnesses =>
    _harnesses.values.toList(growable: false);

/// Whether [id] names a domain-specific harness rather than an engine. The
/// slash is the tell: engine ids are bare words, harness ids are `owner/name`.
bool isHarnessId(String? id) => id != null && id.contains('/');

EngineIdentity engineIdentity(String? engine, {String? displayName}) {
  final id = engine?.trim().toLowerCase() ?? '';
  final known = _engines[id] ?? _harnesses[id];
  if (known != null) return known;
  final raw = displayName?.trim().isNotEmpty == true
      ? displayName!.trim()
      // An unknown harness reads by its name, never its owner: `someone/robot-arm`
      // is a "Robot-arm" tile, and the owner is a fact for the install screen.
      : isHarnessId(id)
      ? id.substring(id.lastIndexOf('/') + 1)
      : id.isEmpty
      ? 'Agent'
      : id;
  final label = raw.isEmpty ? 'Agent' : raw[0].toUpperCase() + raw.substring(1);
  return EngineIdentity(
    id: id.isEmpty ? 'unknown' : id,
    label: label,
    color: AppColors.mutedStrong,
  );
}

/// What an agent is drawn AS: its harness when it was created from one, else
/// its engine. Every mark that has an [Agent] in hand goes through here, so a
/// Circuit agent is Circuit in the rail, the header, the switcher and the tab
/// alike — and so a new place to draw one cannot quietly show Claude instead.
EngineIdentity agentIdentity(Agent agent) => engineIdentity(
  agent.identityEngine,
  displayName: agent.identityDisplayName,
);

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

  /// The mark for [agent] — see [agentIdentity].
  EngineMark.forAgent(
    Agent agent, {
    super.key,
    this.enabled = true,
    this.size = 16,
  }) : engine = agent.identityEngine,
       displayName = agent.identityDisplayName;

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
