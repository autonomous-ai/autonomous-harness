import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;

/// The sign-in screen's one picture: three machines you own, feeding one
/// window, through a middle that cannot read what it carries.
///
/// **The animation is the explanation, not decoration.** A packet leaves a
/// machine as a bare grey dot — plaintext, on hardware you control — and
/// crosses the hub, where it *becomes* a glowing sealed block and keeps that
/// halo for the rest of the trip. Nothing else in the frame moves on its own:
/// every motion here is a consequence of a packet, which is why the eye is
/// never pulled toward a part of the diagram that has nothing to say. An
/// earlier pass had a rotating rim light on the hub and a sheen sweeping the
/// whole window; both were cut for exactly that reason — they animated a thing
/// that wasn't doing anything, and the sweep reacted across four panes when
/// only one had received anything.
///
/// One clock drives all of it ([_period]), with each lane offset by
/// [_laneStagger]. That is what makes six moving parts read as one instrument
/// rather than six effects arguing; it is also why the aurora's period is an
/// exact multiple of the packet period, so the two never drift into a beat
/// against each other.
class LoginRelayDiagram extends StatefulWidget {
  const LoginRelayDiagram({super.key});

  /// The drawing's own aspect, so the caller can size it without guessing.
  static const double aspectRatio = 440 / 140;

  @override
  State<LoginRelayDiagram> createState() => _LoginRelayDiagramState();
}

/// The shared heartbeat. Every lane, halo and pane flash is a phase of this.
const Duration _period = Duration(milliseconds: 3200);

/// How far apart the three lanes fire: one third of the cycle each, so the
/// three packets are spread evenly around it rather than travelling as a clump.
///
/// **This is not a taste setting.** At the 0.075 it started on, the lanes were
/// so close together that all three were almost always in the same state, and
/// the arithmetic is unforgiving: half of every cycle had NO sealed packet on
/// screen at all, and only 4% of frames showed a grey dot and a glowing block
/// at the same time. The seal is the one beat the whole drawing exists to make,
/// and someone opening the app landed on a frame without it every other time.
///
/// At a third, no frame is ever without a sealed packet, and 76% of them carry
/// both states at once — which is what actually explains the mechanism: plain
/// on one lane, sealed on another, side by side.
const double _laneStagger = 1 / 3;

class _LoginRelayDiagramState extends State<LoginRelayDiagram>
    with SingleTickerProviderStateMixin {
  late final AnimationController _clock = AnimationController(
    vsync: this,
    duration: _period,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Same contract as `Pulse`: Reduce Motion parks the clock rather than
    // slowing it. The value it parks at is deliberate — see [_reducedPhase].
    //
    // `TickerMode` is checked for a second reason, and it is load-bearing: the
    // loop below runs forever, and an endless animation makes `pumpAndSettle`
    // hang for every test that walks through sign-in. The widget test
    // framework disables tickers exactly so that cannot wedge a suite, so
    // honouring it is what lets this screen loop for a real user while staying
    // testable. It is also what stops the clock behind a pushed route.
    final stilled =
        MediaQuery.disableAnimationsOf(context) ||
        !TickerMode.valuesOf(context).enabled;
    if (stilled) {
      _clock
        ..stop()
        ..value = _reducedPhase;
    } else if (!_clock.isAnimating) {
      _clock.repeat();
    }
  }

  /// Where the frame stops for someone who asked for less motion.
  ///
  /// Mid-crossing, *after* the seal: the still frame still shows a grey dot on
  /// one lane and a glowing block on another, so the picture keeps making its
  /// point instead of becoming a diagram of nothing happening. Freezing at 0
  /// would hide the packets entirely, which is the one thing this drawing
  /// exists to show.
  ///
  /// The value is tied to [_laneStagger] and has to be rechecked with it: at a
  /// third-of-a-cycle stagger this frame reads SEALED / RAW / just-landed
  /// across the three lanes, which is the whole story in one picture. Push it
  /// to 0.60 and the second lane is mid-seal rather than plain, so the contrast
  /// the frame is chosen for goes away.
  static const double _reducedPhase = 0.52;

  @override
  void dispose() {
    _clock.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // Colours are resolved HERE, in build, not inside the painter: the painter
    // is handed plain values so it never reads a theme-dependent getter from a
    // paint callback, which runs outside the element that depends on the theme.
    final palette = _DiagramPalette(
      // `guide`, not `divider`, and the token file draws the line itself: a
      // divider only has to be findable at a seam the eye is already looking
      // at, while a guide is a long thin run the eye has to FOLLOW — which is
      // exactly what these lanes are. It also lands at the same weight in both
      // themes (1.45 light / 1.48 dark, measured with tool/contrast.py), where
      // divider is a step fainter in light (1.14) than dark (1.25) and left
      // the whole diagram looking washed out on the white palette.
      wire: grid.AppPalette.guide,
      nodeFill: grid.AppCard.inset,
      hubFill: grid.AppSurface.accentWash,
      accent: grid.AppPalette.accentOnSurface,
      raw: grid.AppPalette.textFaint,
      ink: grid.AppPalette.textSecondary,
      // ⚠️ NOT `textFaint`. This colour carries "we can't read this" — the
      // privacy claim the whole drawing exists to make — and faint measured
      // 3.33:1 light / 3.18:1 dark against the hub, under the 4.5:1 WCAG 1.4.3
      // asks of body text. `textSecondary` puts it at 6.21 / 6.82. A sentence
      // this load-bearing does not get to be decorative grey.
      faint: grid.AppPalette.textSecondary,
      online: grid.AppPalette.online,
      isDark: grid.AppTheme.isDark,
    );
    final labels = _DiagramLabels(
      nodes: const ['MacBook', 'Server', 'Cloud'],
      // Said the way anyone reads it. The cipher names that used to sit on this
      // screen (Ed25519, ChaCha20-Poly1305) were true and unreadable to almost
      // everyone who saw them; they belong on a security page.
      //
      // "we" is doing real work here and is worth keeping. The headline
      // promises the READER sees everything; this line is about a different
      // subject entirely — us — and without the pronoun the two collapse into
      // one confused claim about who can read what. The card's subhead used to
      // repeat this as "cannot open it" and was cut for that reason: the
      // sentence belongs on the middle of the diagram, pointing at the thing it
      // is about, not four lines below it in prose.
      //
      // Kept short on purpose: at 9.5px this lands ~80px against a 115px budget
      // inside the hub, and the longer "we can't read any of it" spends all but
      // 12px of that — one wider user-chosen font and it ellipsises. A claim
      // that truncates is worse than a shorter claim.
      hub: "we can't read this",
    );

    return RepaintBoundary(
      child: AspectRatio(
        aspectRatio: LoginRelayDiagram.aspectRatio,
        child: AnimatedBuilder(
          animation: _clock,
          builder: (context, _) => CustomPaint(
            painter: _RelayPainter(
              t: _clock.value,
              palette: palette,
              labels: labels,
            ),
            size: Size.infinite,
          ),
        ),
      ),
    );
  }
}

/// Every colour the painter needs, already resolved for the current theme.
class _DiagramPalette {
  const _DiagramPalette({
    required this.wire,
    required this.nodeFill,
    required this.hubFill,
    required this.accent,
    required this.raw,
    required this.ink,
    required this.faint,
    required this.online,
    required this.isDark,
  });

  final Color wire;
  final Color nodeFill;
  final Color hubFill;
  final Color accent;
  final Color raw;
  final Color ink;
  final Color faint;
  final Color online;

  /// Glow has to be tuned per theme rather than scaled from one value: on a
  /// white page it can only ever be a tint before it turns to haze, while on
  /// charcoal it has room to actually emit. One alpha for both either vanishes
  /// in light or blooms in dark.
  ///
  /// The light numbers were raised after measuring rather than after looking:
  /// at the first pass's 0.22/0.55 the halo landed at 1.38:1 and 2.38:1 against
  /// the card, where dark had 2.01 and 4.56 — so the beat the whole diagram is
  /// built around was ~45% fainter on the white palette and read as a flat blue
  /// square. 0.44 now matches dark's ring almost exactly (1.97 vs 2.01).
  ///
  /// The core deliberately does NOT match: 0.78 gives 3.65 against dark's 4.56,
  /// and closing that gap means a nearly opaque accent disc, which stops
  /// reading as light and starts reading as a sticker. White has less headroom
  /// for glow than charcoal does, and pretending otherwise is how a "matched"
  /// pair ends up looking wrong in one theme.
  double get haloAlpha => isDark ? 0.42 : 0.44;
  double get haloCoreAlpha => isDark ? 0.9 : 0.78;
  double get flowAlpha => isDark ? 0.95 : 0.85;

  final bool isDark;
}

class _DiagramLabels {
  const _DiagramLabels({required this.nodes, required this.hub});
  final List<String> nodes;
  final String hub;
}

/// The drawing, in its own 440×140 space; the canvas is scaled to fit so every
/// number below is the one from the layout rather than a fraction to re-derive.
class _RelayPainter extends CustomPainter {
  _RelayPainter({required this.t, required this.palette, required this.labels});

  final double t;
  final _DiagramPalette palette;
  final _DiagramLabels labels;

  static const Size _design = Size(440, 140);

  // Node boxes, hub, and the three lanes between them.
  static const Rect _hub = Rect.fromLTWH(258, 34, 158, 72);
  static const List<Rect> _nodes = [
    Rect.fromLTWH(24, 20, 94, 28),
    Rect.fromLTWH(24, 56, 94, 28),
    Rect.fromLTWH(24, 92, 94, 28),
  ];
  static const List<Rect> _panes = [
    Rect.fromLTWH(270, 46, 64, 14),
    Rect.fromLTWH(340, 46, 64, 14),
    Rect.fromLTWH(270, 64, 64, 14),
    Rect.fromLTWH(340, 64, 64, 14),
  ];

  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.width / _design.width;
    canvas.save();
    canvas.scale(scale);

    final lanes = _lanes();
    _paintWires(canvas, lanes);
    _paintHub(canvas);
    _paintNodes(canvas);
    _paintPackets(canvas, lanes);

    canvas.restore();
  }

  /// The three curves, built once per paint and reused for the wire, the
  /// travelling energy and the packet's position — so all three cannot drift
  /// apart the way three hand-typed copies of the same path would.
  List<Path> _lanes() {
    Path lane(double fromY) {
      final p = Path()..moveTo(118, fromY);
      if (fromY == 70) {
        p.lineTo(258, 70);
      } else {
        p.cubicTo(180, fromY, 200, 70, 258, 70);
      }
      return p;
    }

    return [lane(34), lane(70), lane(106)];
  }

  void _paintWires(Canvas canvas, List<Path> lanes) {
    final wire = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..color = palette.wire;
    for (final lane in lanes) {
      canvas.drawPath(lane, wire);
    }

    // Energy running the wire, gated to its own packet so a lane is only lit
    // while something is actually on it.
    for (var i = 0; i < lanes.length; i++) {
      final phase = _phaseFor(i);
      final visible = _flowOpacity(phase);
      if (visible <= 0) continue;

      final metric = lanes[i].computeMetrics().first;
      final head = (phase / _travelEnd).clamp(0.0, 1.0) * metric.length;
      final tail = math.max(0.0, head - 34);
      if (head - tail < 0.5) continue;

      final segment = metric.extractPath(tail, head);
      canvas.drawPath(
        segment,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.2
          ..strokeCap = StrokeCap.round
          ..shader = _gradientAlong(
            metric.getTangentForOffset(tail)!.position,
            metric.getTangentForOffset(head)!.position,
            palette.accent,
            palette.flowAlpha * visible,
          ),
      );
    }
  }

  void _paintHub(Canvas canvas) {
    canvas.drawRRect(
      RRect.fromRectAndRadius(_hub, const Radius.circular(10)),
      Paint()..color = palette.hubFill,
    );

    // Four panes — the four terminals the app really runs at once. Each lights
    // when its own packet lands, then settles back; nothing else here moves.
    for (var i = 0; i < _panes.length; i++) {
      final phase = _phaseFor(i);
      final alpha = _paneAlpha(phase);
      canvas.drawRRect(
        RRect.fromRectAndRadius(_panes[i], const Radius.circular(4)),
        Paint()..color = palette.accent.withValues(alpha: alpha),
      );
    }

    // The eye and its caption are laid out as ONE centred group inside the hub
    // rather than at two hand-typed coordinates. Typed positions were wrong
    // twice — first printing the caption left of the hub across the incoming
    // wires, then running it off the right edge with the eye sitting on top of
    // it — because the caption's width is not a number anyone can guess: it
    // changes with the copy, the theme's font and the user's chosen family.
    // Measuring it and centring the pair is the only version that cannot drift.
    const eyeWidth = 17.0;
    const gap = 6.0;
    const padding = 10.0;
    // Bounded by the hub it sits in, not by trust that the string is short:
    // this label is the one piece of prose in the drawing, and prose grows —
    // a longer translation, a wider chosen font, a bigger UI size. Giving the
    // painter a hard ceiling means the worst case is an ellipsis inside the
    // box rather than a sentence printed across the wires outside it.
    final caption = _layOutText(
      labels.hub,
      fontSize: 9.5,
      color: palette.faint,
      maxWidth: _hub.width - eyeWidth - gap - padding * 2,
    );
    final groupWidth = eyeWidth + gap + caption.width;
    final left = _hub.center.dx - groupWidth / 2;
    const centreY = 92.0;

    _paintBlindfold(canvas, Offset(left, centreY));
    caption.paint(
      canvas,
      Offset(left + eyeWidth + gap, centreY - caption.height / 2),
    );
  }

  /// A struck-through eye: the one mark that says "cannot look" without asking
  /// the reader to know a word like *relay* or *zero-knowledge*.
  ///
  /// Drawn from [at], its left edge at that point's x and its centre on its y,
  /// so the caller can place it in a row with the caption beside it.
  void _paintBlindfold(Canvas canvas, Offset at) {
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      // Thinner as well as smaller: at 1.6 the strike-through read as heavy as
      // the hub's own panes, which made a supporting mark compete with the
      // thing it annotates.
      ..strokeWidth = 1.25
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = palette.accent;

    final x = at.dx;
    final y = at.dy;
    final eye = Path()
      ..moveTo(x, y)
      ..relativeCubicTo(3, -3.7, 9.5, -3.7, 12.5, 0)
      ..relativeCubicTo(-3, 3.7, -9.5, 3.7, -12.5, 0)
      ..close();
    canvas.drawPath(eye, stroke);
    canvas.drawCircle(Offset(x + 6.25, y), 1.7, stroke);
    canvas.drawLine(Offset(x - 2, y + 5), Offset(x + 14.5, y - 5), stroke);
  }

  void _paintNodes(Canvas canvas) {
    for (var i = 0; i < _nodes.length; i++) {
      final r = _nodes[i];
      canvas.drawRRect(
        RRect.fromRectAndRadius(r, const Radius.circular(8)),
        Paint()..color = palette.nodeFill,
      );
      // The "this machine is up" dot. It breathes on the shared clock and
      // lands at full strength when the drawing comes to rest — a dot held at
      // half alpha reads as *offline*, which is the opposite of what it means.
      final breath = 0.5 + 0.5 * math.sin(t * 2 * math.pi);
      canvas.drawCircle(
        Offset(r.left + 14, r.center.dy),
        3,
        Paint()..color = palette.online.withValues(alpha: 0.55 + 0.45 * breath),
      );
      _paintText(
        canvas,
        labels.nodes[i],
        Offset(r.left + 26, r.center.dy),
        fontSize: 10.5,
        color: palette.ink,
      );
    }
  }

  /// Where a packet is at phase 1.0 — it arrives before the cycle ends so the
  /// pane it lit has time to settle before the next one leaves.
  static const double _travelEnd = 0.72;

  /// The stretch of the crossing where a packet turns from plaintext into a
  /// sealed block. Centred on the hub's left edge, so the change happens at
  /// the boundary it is about.
  static const double _sealStart = 0.26;
  static const double _sealEnd = 0.38;

  void _paintPackets(Canvas canvas, List<Path> lanes) {
    for (var i = 0; i < lanes.length; i++) {
      final phase = _phaseFor(i);
      if (phase <= 0 || phase >= 1) continue;

      final travel = (phase / _travelEnd).clamp(0.0, 1.0);
      final metric = lanes[i].computeMetrics().first;
      final pos = metric.getTangentForOffset(travel * metric.length)!.position;

      final sealed = ((phase - _sealStart) / (_sealEnd - _sealStart)).clamp(
        0.0,
        1.0,
      );
      final fade = _packetOpacity(phase);
      if (fade <= 0) continue;

      // The halo: ignites at the seal, overshoots, then rides along. This is
      // the beat the whole picture is built around — encryption drawn as a
      // light source rather than written as a word.
      if (sealed > 0) {
        final overshoot = sealed < 1 ? 1 + 0.5 * math.sin(sealed * math.pi) : 1;
        final r = 13.0 * overshoot;
        canvas.drawCircle(
          pos,
          r,
          Paint()
            ..shader = RadialGradient(
              colors: [
                palette.accent.withValues(
                  alpha: palette.haloCoreAlpha * sealed * fade,
                ),
                palette.accent.withValues(
                  alpha: palette.haloAlpha * sealed * fade,
                ),
                palette.accent.withValues(alpha: 0),
              ],
              stops: const [0, 0.45, 1],
            ).createShader(Rect.fromCircle(center: pos, radius: r)),
        );
      }

      if (sealed < 1) {
        // Plaintext: a bare, unremarkable grey dot.
        canvas.drawCircle(
          pos,
          4,
          Paint()..color = palette.raw.withValues(alpha: (1 - sealed) * fade),
        );
      }
      if (sealed > 0) {
        // Ciphertext: a hard-edged block, rotating into place as it forms.
        canvas.save();
        canvas.translate(pos.dx, pos.dy);
        canvas.rotate((1 - sealed) * -math.pi / 4);
        final s = 4.5 * (0.6 + 0.4 * sealed);
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromCenter(center: Offset.zero, width: s * 2, height: s * 2),
            const Radius.circular(1.5),
          ),
          Paint()..color = palette.accent.withValues(alpha: sealed * fade),
        );
        canvas.restore();
      }
    }
  }

  /// This lane's position in the cycle, wrapped into `[0, 1)`.
  double _phaseFor(int lane) => (t - lane * _laneStagger) % 1.0;

  /// Packets fade in as they leave and out once they have landed, so nothing
  /// pops at the seam of the loop.
  double _packetOpacity(double phase) {
    if (phase < 0.06) return phase / 0.06;
    if (phase < _travelEnd) return 1;
    if (phase < 0.88) return 1 - (phase - _travelEnd) / (0.88 - _travelEnd);
    return 0;
  }

  double _flowOpacity(double phase) {
    if (phase < 0.04) return 0;
    if (phase < 0.12) return (phase - 0.04) / 0.08;
    if (phase < 0.66) return 1;
    if (phase < 0.78) return 1 - (phase - 0.66) / 0.12;
    return 0;
  }

  /// A pane rests low, spikes as its packet lands, then settles a step above
  /// where it started — the window keeps what it received.
  double _paneAlpha(double phase) {
    const rest = 0.16;
    const peak = 0.72;
    const settled = 0.30;
    if (phase < 0.66) return rest;
    if (phase < 0.74) {
      return rest + (peak - rest) * ((phase - 0.66) / 0.08);
    }
    if (phase < 1) {
      return peak + (settled - peak) * ((phase - 0.74) / 0.26);
    }
    return rest;
  }

  /// Lay a label out once, so a caller can both measure and place it.
  ///
  /// Anything positioned relative to text has to know its width, and a width
  /// guessed from a character count is wrong the moment the copy, the theme
  /// font, or the user's chosen family changes.
  TextPainter _layOutText(
    String text, {
    required double fontSize,
    required Color color,
    double? maxWidth,
  }) {
    return TextPainter(
      text: TextSpan(
        text: text,
        style: TextStyle(
          fontFamily: grid.AppFont.sans,
          fontFamilyFallback: grid.AppFont.sansFallback,
          fontSize: fontSize,
          color: color,
          letterSpacing: grid.AppFont.trackingFor(fontSize),
          height: 1.0,
        ),
      ),
      textDirection: TextDirection.ltr,
      // The drawing is scaled as a unit, so text inside it must not also take
      // the platform's scaler — that would grow the labels past the boxes they
      // sit in while the boxes stayed put.
      textScaler: TextScaler.noScaling,
      maxLines: 1,
      ellipsis: '…',
    )..layout(maxWidth: maxWidth ?? double.infinity);
  }

  void _paintText(
    Canvas canvas,
    String text,
    Offset at, {
    required double fontSize,
    required Color color,
  }) {
    final painter = _layOutText(text, fontSize: fontSize, color: color);
    painter.paint(canvas, Offset(at.dx, at.dy - painter.height / 2));
  }

  @override
  bool shouldRepaint(covariant _RelayPainter old) =>
      old.t != t ||
      old.palette.accent != palette.accent ||
      old.palette.isDark != palette.isDark;
}

/// A left-to-right gradient between two points on the canvas, used to give the
/// travelling energy a lit head and a dark tail.
Shader _gradientAlong(Offset from, Offset to, Color color, double alpha) {
  return LinearGradient(
    colors: [
      color.withValues(alpha: 0),
      color.withValues(alpha: alpha),
    ],
  ).createShader(Rect.fromPoints(from, to));
}

/// The atmosphere behind the sign-in card: two very low-alpha blobs drifting
/// on a multiple of the diagram's own clock.
///
/// It is what makes the window read as *lit* rather than printed, and it is
/// the piece that carries the design into the corners of a 1280×800 window
/// that the card itself leaves empty. Alphas are tuned per theme for the same
/// reason the packet halo is: on a near-white panel this can only ever be a
/// tint before it turns to haze, while charcoal has room for it to glow.
///
/// The period is an exact multiple of [_period] so the two never drift into a
/// beat against each other — the whole screen stays one instrument.
class LoginAurora extends StatefulWidget {
  const LoginAurora({super.key});

  @override
  State<LoginAurora> createState() => _LoginAuroraState();
}

class _LoginAuroraState extends State<LoginAurora>
    with SingleTickerProviderStateMixin {
  late final AnimationController _drift = AnimationController(
    vsync: this,
    duration: _period * 4,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final stilled =
        MediaQuery.disableAnimationsOf(context) ||
        !TickerMode.valuesOf(context).enabled;
    if (stilled) {
      _drift
        ..stop()
        ..value = 0.5;
    } else if (!_drift.isAnimating) {
      _drift.repeat();
    }
  }

  @override
  void dispose() {
    _drift.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final dark = grid.AppTheme.isDark;
    final a = grid.AppPalette.accentOnSurface.withValues(
      alpha: dark ? 0.10 : 0.055,
    );
    final b = grid.AppPalette.teal.withValues(alpha: dark ? 0.07 : 0.045);

    return IgnorePointer(
      child: RepaintBoundary(
        child: AnimatedBuilder(
          animation: _drift,
          builder: (context, _) => CustomPaint(
            painter: _AuroraPainter(t: _drift.value, a: a, b: b),
            size: Size.infinite,
          ),
        ),
      ),
    );
  }
}

class _AuroraPainter extends CustomPainter {
  _AuroraPainter({required this.t, required this.a, required this.b});

  final double t;
  final Color a;
  final Color b;

  @override
  void paint(Canvas canvas, Size size) {
    // A full sine over the cycle, so the loop closes on itself with no jump.
    final phase = math.sin(t * 2 * math.pi);
    _blob(
      canvas,
      Offset(
        size.width * (0.28 + 0.04 * phase),
        size.height * (0.30 + 0.05 * phase),
      ),
      size.shortestSide * (0.62 + 0.05 * phase),
      a,
    );
    _blob(
      canvas,
      Offset(
        size.width * (0.74 - 0.04 * phase),
        size.height * (0.72 - 0.05 * phase),
      ),
      size.shortestSide * (0.56 - 0.05 * phase),
      b,
    );
  }

  /// A soft radial pool. Drawn as a gradient rather than a blurred circle:
  /// `MaskFilter.blur` at this radius is a real per-frame cost on a surface
  /// that covers the whole window, and a gradient gets the same falloff free.
  void _blob(Canvas canvas, Offset centre, double radius, Color color) {
    canvas.drawCircle(
      centre,
      radius,
      Paint()
        ..shader = RadialGradient(
          colors: [color, color.withValues(alpha: 0)],
          stops: const [0, 1],
        ).createShader(Rect.fromCircle(center: centre, radius: radius)),
    );
  }

  @override
  bool shouldRepaint(covariant _AuroraPainter old) =>
      old.t != t || old.a != a || old.b != b;
}
