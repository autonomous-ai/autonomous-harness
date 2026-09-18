import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

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

  /// A few words in the project's own terms, from its website or repository
  /// — "Advanced physics simulation" — under the name in the agent search.
  /// For a harness, the catalog's `tagline` wins; this is the build's words
  /// for a machine whose CLI does not send one.
  final String? tagline;

  const EngineIdentity({
    required this.id,
    required this.label,
    required this.color,
    this.asset,
    this.category,
    this.creator,
    this.homepage,
    this.blurb,
    this.tagline,
  });

  /// "Code · OpenAI", "CAD · Jake Fitzgerald" — the tile's second line.
  String? get detail {
    final parts = [
      category,
      creator,
    ].whereType<String>().where((s) => s.isNotEmpty);
    return parts.isEmpty ? null : parts.join(' · ');
  }
}

const _engines = <String, EngineIdentity>{
  'claude': EngineIdentity(
    id: 'claude',
    label: 'Claude',
    category: 'Code',
    tagline: 'Work with Claude directly in your codebase',
    creator: 'Anthropic',
    color: Color(0xffcc7c5e),
    homepage: 'https://claude.com/product/claude-code',
    blurb: "Anthropic's agentic coding tool in the terminal: reads the codebase, edits, runs tests, opens pull requests.",
  ),
  'codex': EngineIdentity(
    id: 'codex',
    label: 'Codex',
    category: 'Code',
    tagline: 'Coding agent that runs in your terminal',
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
    tagline: 'Ship code with agents, right from your terminal',
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
    tagline: 'Open source AI coding agent',
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
    tagline: 'Terminal-based coding agent',
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
    tagline: 'Open-source AI agent that grows with you',
    creator: 'Nous Research',
    color: Color(0xff9b8cff),
    asset: 'assets/engine-icons/hermes.png',
    homepage: 'https://github.com/NousResearch/hermes-agent',
    blurb:
        "Nous Research's open agent with memory and skills, in the terminal.",
  ),
  'commandcode': EngineIdentity(
    id: 'commandcode',
    label: 'Command Code',
    category: 'Code',
    tagline: 'Coding agent built for open models',
    creator: 'Command Code',
    color: Color(0xfff5f5f5),
    asset: 'assets/engine-icons/commandcode.png',
    blurb: "Command Code's coding agent for the terminal.",
  ),
  'devin': EngineIdentity(
    id: 'devin',
    label: 'Devin',
    category: 'Code',
    tagline: 'AI software engineer',
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
    tagline: 'Coding agent for complex coding workstreams',
    creator: 'Meta',
    color: Color(0xff0082fb),
    asset: 'assets/engine-icons/muse.png',
    blurb: "Meta's coding agent for the terminal.",
  ),
  'amp': EngineIdentity(
    id: 'amp',
    label: 'Amp',
    category: 'Code',
    tagline: 'Coding agent and dev environment',
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
    tagline: 'Open source AI coding agent in IDE, CLI and cloud',
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
    tagline: 'Coding agent that runs right from your terminal',
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
    tagline: 'Run a GitHub-native agent in your terminal',
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
    tagline: 'Next-gen agent platform',
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
    tagline: 'Get a verified PCB and a fab packet you can order',
    creator: 'Autonomous',
    color: Color(0xffd98a4a),
    asset: 'assets/engine-icons/autonomous-circuit.png',
  ),
  // KiCad is Autonomous Circuit's second wrapper (its KiCad-native pipeline,
  // #91, renamed): it changes nothing of KiCad, so — as Blender, Typst and Marp
  // do — it carries the wrapped project's name and mark. The icon is KiCad's
  // own application icon (icon_kicad.svg in its source tree) rendered at 256 px.
  'autonomous/kicad': EngineIdentity(
    id: 'autonomous/kicad',
    label: 'KiCad',
    category: 'PCB',
    tagline: 'A real KiCad project: wired schematic, DRC-checked copper, a prototype packet',
    creator: 'KiCad',
    color: Color(0xffff6d00),
    asset: 'assets/engine-icons/kicad.png',
  ),
  // Grid's own mark — the bolt from the Grid app's icon (autonomous-grid-app,
  // branding/app_icon.svg); ours, like Circuit's and Workshop's.
  'autonomous/autonomous-grid': EngineIdentity(
    id: 'autonomous/autonomous-grid',
    label: 'Grid',
    category: 'Compute',
    tagline: 'Deploy open-weight models across your machines and watch the fleet live',
    creator: 'Autonomous',
    color: Color(0xfff5a623),
    asset: 'assets/engine-icons/autonomous-grid.png',
  ),
  'autonomous/autonomous-workshop': EngineIdentity(
    id: 'autonomous/autonomous-workshop',
    label: 'Autonomous Workshop',
    category: 'CAD',
    tagline: 'AI inventors that make new toys and games',
    creator: 'Autonomous',
    color: Color(0xff5a52d8),
    asset: 'assets/engine-icons/autonomous-workshop.png',
  ),
  'autonomous/marp': EngineIdentity(
    id: 'autonomous/marp',
    label: 'Marp',
    category: 'Slides',
    tagline: 'Create beautiful slide decks using Markdown',
    creator: 'Yuki Hattori',
    color: Color(0xff218cdb),
    asset: 'assets/engine-icons/marp.png',
  ),
  'autonomous/text-to-cad': EngineIdentity(
    id: 'autonomous/text-to-cad',
    label: 'text-to-cad',
    category: 'CAD',
    tagline: 'Library of agent skills for CAD, CAE and CAM',
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
    tagline: 'Markup-based typesetting system',
    creator: 'Typst GmbH',
    color: Color(0xff239dad),
    asset: 'assets/engine-icons/typst.png',
  ),
  'autonomous/manim': EngineIdentity(
    id: 'autonomous/manim',
    label: 'Manim',
    category: 'Math animation',
    tagline: 'Python library for creating mathematical animations',
    creator: 'Manim Community',
    color: Color(0xffe0a458),
    asset: 'assets/engine-icons/manim.png',
  ),
  'autonomous/excalidraw': EngineIdentity(
    id: 'autonomous/excalidraw',
    label: 'Excalidraw',
    category: 'Diagrams',
    tagline: 'Collaborative whiteboarding made easy',
    creator: 'Excalidraw',
    color: Color(0xff6965db),
    asset: 'assets/engine-icons/excalidraw.png',
  ),
  'autonomous/marimo': EngineIdentity(
    id: 'autonomous/marimo',
    label: 'marimo',
    category: 'Notebooks',
    tagline: 'Next-generation Python notebook',
    creator: 'marimo',
    color: Color(0xff1c7c54),
    asset: 'assets/engine-icons/marimo.png',
  ),
  'autonomous/remotion': EngineIdentity(
    id: 'autonomous/remotion',
    label: 'Remotion',
    category: 'Video',
    tagline: 'Make videos programmatically',
    creator: 'Remotion',
    color: Color(0xff0b84f3),
    asset: 'assets/engine-icons/remotion.png',
  ),
  'autonomous/blender': EngineIdentity(
    id: 'autonomous/blender',
    label: 'Blender',
    category: '3D',
    tagline: 'Free and open source 3D creation software',
    creator: 'Blender Foundation',
    color: Color(0xffe87d0d),
    asset: 'assets/engine-icons/blender.png',
  ),
  'autonomous/mujoco': EngineIdentity(
    id: 'autonomous/mujoco',
    label: 'MuJoCo',
    category: 'Simulation',
    tagline: 'Advanced physics simulation',
    creator: 'Google DeepMind',
    color: Color(0xff1b2a6b),
    asset: 'assets/engine-icons/mujoco.png',
  ),
  'autonomous/phaser': EngineIdentity(
    id: 'autonomous/phaser',
    label: 'Phaser',
    category: 'Games',
    tagline: 'Open source HTML5 game framework',
    creator: 'Phaser Studio',
    color: Color(0xff2a5bd7),
    asset: 'assets/engine-icons/phaser.png',
  ),
  'autonomous/strudel': EngineIdentity(
    id: 'autonomous/strudel',
    label: 'Strudel',
    category: 'Music',
    tagline: 'Music live coding environment for the browser',
    creator: 'Strudel',
    color: Color(0xffe0577b),
    asset: 'assets/engine-icons/strudel.png',
  ),
  'autonomous/rdkit': EngineIdentity(
    id: 'autonomous/rdkit',
    label: 'RDKit',
    category: 'Chemistry',
    tagline: 'Open-source cheminformatics software',
    creator: 'RDKit',
    color: Color(0xff1d7bb8),
    asset: 'assets/engine-icons/rdkit.png',
  ),
  'autonomous/yosys': EngineIdentity(
    id: 'autonomous/yosys',
    label: 'Yosys',
    category: 'Chips',
    tagline: 'Framework for Verilog RTL synthesis',
    creator: 'YosysHQ',
    color: Color(0xff2f7d5b),
    asset: 'assets/engine-icons/yosys.png',
  ),
  'autonomous/circuitjs': EngineIdentity(
    id: 'autonomous/circuitjs',
    label: 'CircuitJS',
    category: 'Circuits',
    tagline: 'Electronic circuit simulator in the browser',
    creator: 'Paul Falstad',
    color: Color(0xff50fa78),
    asset: 'assets/engine-icons/circuitjs.png',
  ),
  // OpenMontage's own logo (`assets/logo.png` in its repository), trimmed to
  // its outer ring so the play mark reads at tab size.
  'autonomous/openmontage': EngineIdentity(
    id: 'autonomous/openmontage',
    label: 'OpenMontage',
    category: 'Video',
    tagline: 'Open-source agentic video production',
    creator: 'calesthio',
    color: Color(0xffe8894a),
    asset: 'assets/engine-icons/openmontage.png',
  ),
  // Of the eight studios of 2026-09-18, three wear their project's own mark —
  // Comfy's `assets/logo.svg`, Dimensional's favicon, Bonsai's desktop icon
  // from IfcOpenShell. The other five (Ableton AI, autoresearch-mlx,
  // Foam-Agent, JUCE Agent Toolkit, SimSkill) publish no logo of their own,
  // and the marks they sit beside (Ableton, JUCE, OpenFOAM, SUMO) are other
  // companies' trademarks — so, like Godogen, they are not here and draw their
  // initial; their words come from the Store's catalog.
  'autonomous/comfy-mcp': EngineIdentity(
    id: 'autonomous/comfy-mcp',
    label: 'Comfy MCP',
    category: 'Generative media',
    tagline: 'Local MCP server for ComfyUI — run ComfyUI from AI agents',
    creator: 'Comfy Org',
    color: Color(0xffe5ff3d),
    asset: 'assets/engine-icons/comfy-mcp.png',
  ),
  'autonomous/dimos': EngineIdentity(
    id: 'autonomous/dimos',
    label: 'DimOS',
    category: 'Robotics',
    tagline: 'The agentic operating system for physical space',
    creator: 'Dimensional',
    color: Color(0xffb0e1f0),
    asset: 'assets/engine-icons/dimos.png',
  ),
  'autonomous/bonsai-mcp': EngineIdentity(
    id: 'autonomous/bonsai-mcp',
    label: 'Bonsai MCP',
    category: 'Architecture',
    tagline: 'MCP server for a live Blender + Bonsai (BlenderBIM) session',
    creator: 'Show2Instruct',
    color: Color(0xff8c6f5e),
    asset: 'assets/engine-icons/bonsai-mcp.png',
  ),
};

/// The base engine each first-party harness runs on, so the Create dialog can
/// say "Runs on Claude Code" — and send the right `engine` — before the machine
/// has answered `dsh_list`. The daemon's catalog is authoritative when present.
const knownHarnessBase = <String, String>{
  'autonomous/autonomous-circuit': 'claude',
  'autonomous/kicad': 'claude',
  'autonomous/autonomous-grid': 'codex',
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
  'autonomous/openmontage': 'claude',
  'autonomous/comfy-mcp': 'codex',
  'autonomous/dimos': 'codex',
  'autonomous/bonsai-mcp': 'codex',
};

/// The daemon's engine id for a plain shell in a pane (⌘⇧T, New Terminal — and
/// the last row of New Harness's agent list, as [terminalIdentity]).
///
/// Deliberately NOT in [_engines]: [allEngines] is what `engines_probe` asks a
/// machine about and what the Store shelves as an engine, and a terminal is
/// neither installable nor absent — every machine has a shell. New Harness
/// lists it on its own, after the agents. It still has a face, because a tile
/// shows one, and the daemon swaps the tile's engine for whatever gets typed
/// into it, so the face must come and go through the same [engineIdentity]
/// every other mark reads.
const String kTerminalEngine = 'terminal';

const EngineIdentity _terminal = EngineIdentity(
  id: kTerminalEngine,
  label: 'Terminal',
  category: 'Shell',
  tagline: 'Your shell, in a tile',
  blurb:
      'A plain shell on the machine, in a tile beside your agents: no engine, '
      'no first task, nothing to install.',
  color: Color(0xffa8b0b8),
);

/// The terminal's face, for the one list that offers it: New Harness.
EngineIdentity get terminalIdentity => _terminal;

/// Whether [engine] is the shell rather than an agent.
bool isTerminalEngine(String? engine) => engine == kTerminalEngine;

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
  final known =
      _engines[id] ??
      _harnesses[id] ??
      (id == kTerminalEngine ? _terminal : null);
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
        : identity.id == kTerminalEngine
        ? Icon(
            LucideIcons.terminal,
            key: const ValueKey('engine-icon-terminal'),
            size: size,
            color: identity.color,
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
