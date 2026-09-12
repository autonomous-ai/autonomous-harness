import 'dart:io' show Platform;

import 'package:flutter/material.dart';

/// The app's live brightness — the single source of truth the color tokens below
/// resolve against. Harness Desktop is dark-only: `_GridTokenScope` (in
/// `main.dart`) pins this to [Brightness.dark] once, at the top of the tree.
///
/// Every `AppPalette`/`AppSurface`/`AppGlass`/`AppCard` member is a getter that
/// switches on this, so a call site like `color: AppPalette.windowBg` follows the
/// theme with no change to the call site.
abstract final class AppTheme {
  static final BrightnessNotifier brightness = BrightnessNotifier(
    Brightness.dark,
  );

  /// Fires when the user's type settings change. Separate from [brightness]
  /// because the two are independent — a theme flip must not restyle type, and
  /// changing the font must not repaint as though the palette moved — but read
  /// through the same [watch], since a widget that reads one token generally
  /// reads both.
  static final FontNotifier fonts = FontNotifier();

  static bool get isDark => brightness.value == Brightness.dark;

  /// Pick between a light and a dark value for the current brightness.
  static T pick<T>(T light, T dark) => isDark ? dark : light;

  /// Read tokens as some *other* brightness would resolve them.
  ///
  /// The tokens resolve against one global ([brightness]), which is what makes a
  /// call site like `AppPalette.windowBg` follow the theme with no plumbing — but
  /// it also means the dark palette is unreadable while the app is light. The
  /// theme preview needs exactly that: three swatches, each showing a palette the
  /// app is *not* currently wearing.
  ///
  /// So: swap the global, read, put it back. Safe because it's synchronous and
  /// restores in a `finally` — nothing can observe the swapped value, and the
  /// swap is [BrightnessNotifier.muted] so it doesn't dirty every widget
  /// watching the theme on the way out and back.
  ///
  /// Do not `await` inside [read]: that would hand the swapped brightness to the
  /// rest of the frame, and the app would paint half a palette.
  static T as<T>(Brightness other, T Function() read) {
    final previous = brightness.value;
    if (previous == other) return read();
    return brightness.muted(() {
      try {
        brightness.value = other;
        return read();
      } finally {
        brightness.value = previous;
      }
    });
  }

  /// Registers the calling widget to rebuild whenever [brightness] flips, and
  /// returns the current value.
  ///
  /// The color tokens read [brightness] `.value` directly — a plain field read
  /// the element tree can't see — so a widget that only reads tokens has no
  /// tracked reason to rebuild when the theme changes. Worse, the app is full of
  /// `const` chrome (`const AppSidebar()`, `const _MainShellBody()`), and a
  /// `const` child is reference-identical across a parent's rebuild, so Flutter
  /// short-circuits it: rebuilding from the top never reaches the sidebar, and it
  /// stays on the old palette until something *else* (a Riverpod change from
  /// clicking a row) happens to rebuild it.
  ///
  /// Calling this at the top of a chrome widget's `build` fixes that at the root:
  /// it depends on the [_BrightnessScope] inherited widget, whose notifier is
  /// [brightness]. An `InheritedNotifier` marks its dependents dirty *directly*
  /// when the notifier fires — it doesn't rebuild through the widget tree — so
  /// every `const` boundary in between is irrelevant. This is exactly how
  /// `Theme.of(context)` makes a widget follow the theme.
  /// It also registers for type changes, via [_FontScope]. The two travel
  /// together deliberately: `AppTheme.watch(context)` is the one line a widget
  /// adds to follow the app's appearance, and splitting it into two calls would
  /// mean every widget that already follows the theme still silently ignores the
  /// font — with the exact same symptom (stuck on the value it first built with)
  /// that this method exists to fix.
  static Brightness watch(BuildContext context) {
    context.dependOnInheritedWidgetOfExactType<_BrightnessScope>();
    context.dependOnInheritedWidgetOfExactType<_FontScope>();
    return brightness.value;
  }
}

/// Fires when [AppFont]'s user settings change.
///
/// It carries no value: the settings live on [AppFont] as statics, because a
/// token read like `AppFont.mono` has no context to look one up with. This is
/// only the signal that they moved.
class FontNotifier extends ChangeNotifier {
  /// Push new settings onto [AppFont] and notify, but only if they differ —
  /// setting the same font twice must not dirty the tree.
  void apply({
    String? uiFamily,
    String? codeFamily,
    required double uiScale,
    required double codeSize,
  }) {
    final changed = AppFont.apply(
      uiFamily: uiFamily,
      codeFamily: codeFamily,
      uiScale: uiScale,
      codeSize: codeSize,
    );
    if (changed) notifyListeners();
  }
}

/// The brightness global, with one extra power: it can be moved *silently*.
///
/// [AppTheme.as] swaps the brightness to read the other palette and swaps it
/// straight back. A plain `ValueNotifier` broadcasts both of those moves, so
/// every widget watching the theme would be marked dirty twice per swatch — six
/// spurious rebuilds to draw three previews, all to end up back where we
/// started. [muted] suppresses the broadcast for a change that is, from the
/// outside, not a change at all.
class BrightnessNotifier extends ValueNotifier<Brightness> {
  BrightnessNotifier(super.value);

  bool _muted = false;

  /// Run [body] with notifications suppressed. Only for a swap that restores the
  /// original value before anything can observe it — see [AppTheme.as].
  T muted<T>(T Function() body) {
    final previous = _muted;
    _muted = true;
    try {
      return body();
    } finally {
      _muted = previous;
    }
  }

  @override
  void notifyListeners() {
    if (_muted) return;
    super.notifyListeners();
  }
}

/// Wraps the app so any descendant that calls [AppTheme.watch] rebuilds when the
/// brightness flips or the user's type settings change — regardless of the
/// `const` widgets in between. Mount it once, high in the tree (see
/// `grid_app.dart`).
///
/// The name predates the font settings and is kept: it's mounted in one place,
/// and every call site in the app already knows this as the widget that makes
/// [AppTheme.watch] work.
class BrightnessScope extends StatelessWidget {
  const BrightnessScope({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return _BrightnessScope(
      notifier: AppTheme.brightness,
      child: _FontScope(notifier: AppTheme.fonts, child: child),
    );
  }
}

class _BrightnessScope extends InheritedNotifier<ValueNotifier<Brightness>> {
  const _BrightnessScope({required super.notifier, required super.child});
}

class _FontScope extends InheritedNotifier<FontNotifier> {
  const _FontScope({required super.notifier, required super.child});
}

/// The app's palette — a warm paper white with near-black ink in light, a deep
/// charcoal with off-white ink in dark (the design-system "Codex" direction).
/// Centralized so every pane reads the same surfaces/accents instead of re-typing
/// hex literals, and resolves per [AppTheme.brightness].
abstract final class AppPalette {
  // Approved Swarms canvas and native tab-strip palette.
  static Color get swarmField => const Color(0xff463746);
  static Color get swarmTabBar => const Color(0xff332936);
  static Color get swarmAccent => const Color(0xffd8cce1);

  // the conversation / content area — pure white in light, like Codex.
  //
  // Dark is a charcoal page rather than the near-black it was (#0A0A0A). That
  // moves every surface above it closer: a card lands at 1.065:1 where it had
  // 1.188, a dialog at 1.090 where it had 1.215, and [AppPalette.panelBg]
  // (#141414) is now *darker* than the page it sits on. Depth in dark is
  // therefore carried by the rim and the shadow, not by the fill — §2's stack
  // still holds, it just has less room to say it in.
  static Color get windowBg =>
      AppTheme.pick(const Color(0xFFFFFFFF), const Color(0xFF181818));

  // sidebar column — a barely-there cool grey (Codex keeps the rail almost white,
  // set apart by a hairline, not a tone) / charcoal panel in dark.
  static Color get panelBg =>
      AppTheme.pick(const Color(0xFFF9F9F8), const Color(0xFF141414));

  // input fills, quiet cards
  static Color get cardBg =>
      AppTheme.pick(const Color(0xFFF3F3F2), const Color(0xFF1E1E1E));

  static Color get cardBgHover =>
      AppTheme.pick(const Color(0xFFECECEA), const Color(0xFF252525));

  // A hairline separator. Light: a faint cool black; dark: a faint white — a
  // black divider would vanish on charcoal.
  static Color get divider =>
      AppTheme.pick(const Color(0x0F000000), const Color(0x14FFFFFF));

  /// A hairline that has to hold a *shape* rather than just part two blocks —
  /// the tree guide threading the sidebar's projects and their chats.
  ///
  /// Stronger than [divider], and deliberately so. A separator only has to be
  /// findable at the seam the eye is already looking at; a guide is a long thin
  /// run the eye has to follow, and at the divider's weight it stops reading as
  /// one line and breaks into stray ticks wherever anything crosses it.
  /// Measured against the rail it is drawn on (`AppGlass.sidebarFill`, over
  /// [windowBg] in light): divider lands at **1.14:1 light / 1.27:1 dark**,
  /// this at **1.45:1 light / 1.47:1 dark**.
  ///
  /// The two alphas differ because the rails differ — `#F9F9F8` light against
  /// `#242424` dark — and matching the *numbers* rather than the alphas is what
  /// keeps the guide equally present in both themes instead of a step fainter
  /// in light, which is how the divider's pair behaved.
  static Color get guide =>
      AppTheme.pick(const Color(0x29000000), const Color(0x20FFFFFF));

  // primary action — a solid fill with white text on it, so it has to stay dark
  // enough to carry that text (white on this is 5.5:1). Same value in both
  // themes: as a *fill* it reads on either surface.
  static const accent = Color(0xFF2F5BEA);

  /// The fill under a destructive **filled** button — Remove, Delete.
  ///
  /// Not `colorScheme.error`, and the reason is what that colour is *for*: dark's
  /// `#F2544B` is tuned to read as **ink on a dark surface**, which is why
  /// `AppIconButton` needs one lighter still. As a *fill* it leaves white
  /// lettering at 3.42:1, under the 4.5:1 floor — and Material's own `onError`
  /// substitute reaches only 3.83:1, so no foreground rescues it. Darkened until
  /// white clears the bar with the room the app's own accent button already has:
  ///
  /// ```
  ///                        white on fill   fill vs dialog
  /// accent   #2F5BEA           5.52             3.02
  /// this     #C92E26 (dark)    5.38             3.10
  /// this     #B3261E (light)   6.54             6.54
  /// ```
  static Color get dangerFill =>
      AppTheme.pick(const Color(0xFFB3261E), const Color(0xFFC92E26));

  /// The accent as a *mark on a surface* — a selected row's icon, an accent
  /// rail — rather than a fill behind white text.
  ///
  /// It has to part from [accent] in dark. A selected rail row composites to
  /// #353535, and #2F5BEA on that is 2.2:1 — under the 3.0 WCAG 1.4.11 asks of
  /// a UI element, which is why the selected icon read as flat charcoal-on-
  /// charcoal there while light (4.6:1) was fine. Lightened to 3.97:1 on that
  /// row, still plainly the same indigo. [accent] can't simply take this value:
  /// it is the fill under white text in ~100 places, and lightening it there
  /// would drop that text to ~3.1:1 — fixing the icon by breaking the buttons.
  static Color get accentOnSurface =>
      AppTheme.pick(const Color(0xFF2F5BEA), const Color(0xFF6E8BFF));

  // avatar fill (white text on it); a touch brighter in dark for contrast.
  static Color get accentMuted =>
      AppTheme.pick(const Color(0xFF3550C8), const Color(0xFF4E6BF0));

  /// The initial tile beside a name in a roster — the accent's hue with most of
  /// its saturation taken out, so a column of ten of them reads as a list rather
  /// than as ten buttons.
  ///
  /// **Not [accent] or [accentMuted].** Both are made to be *loud*: one is the
  /// fill under a primary button, the other the base of the account avatar that
  /// marks **you**. A saturated indigo is right for one mark on a screen and
  /// wrong for a mark on every row — a whole panel of them pulled the eye off
  /// the names they were meant to introduce.
  ///
  /// Still a solid fill under white text, and still measured for it: 5.26:1 in
  /// light, 6.19:1 in dark. Softening a mark must not cost the letter inside it,
  /// which is the only part carrying information — a tint at 14% alpha would
  /// have taken the glyph to 4.5:1 at rest and under it on a hovered row.
  ///
  /// Slightly deeper in dark, where the tile stands on charcoal (2.63:1 against
  /// the panel) rather than on white (5.26:1).
  static Color get avatarFill =>
      AppTheme.pick(const Color(0xFF5369AC), const Color(0xFF4B5F9B));

  /// The colours a member's circle is drawn in, one per person — see
  /// `memberAvatarSlot`, which decides which of them an address takes.
  ///
  /// **The same list in both themes, deliberately.** Every other colour here
  /// resolves per brightness; this one must not, because here the colour *is*
  /// the identity. A person who is teal on the dark theme and green on the light
  /// one is two people to the eye, and the whole reason for colouring a roster
  /// is that a face can be found before it is read.
  ///
  /// Eight hues rather than a generated spread: a hash over a continuous wheel
  /// puts neighbouring people two degrees apart as often as not, and a palette
  /// picked by hand is the only way the marks stay *told apart*. All eight carry
  /// white at ≥5:1 (measured: 5.02 green → 7.10 violet), which is what the
  /// letter needs — the disc itself is a container, and lands at 2.3–3.5:1
  /// against the panels it sits on, the same band [avatarFill] occupies today.
  static const avatarPalette = <Color>[
    Color(0xFF1D5BD6), // blue
    Color(0xFF0F766E), // teal
    Color(0xFF15803D), // green
    Color(0xFFA65A08), // amber
    Color(0xFFBE123C), // rose
    Color(0xFF6D28D9), // violet
    Color(0xFFA21CAF), // fuchsia
    Color(0xFF4E5D78), // slate
  ];

  /// The primary action's fill under the pointer — the top bar's Invite button.
  ///
  /// **Deepens in light, brightens in dark**, rather than one shift applied to
  /// both: hover should raise the control's contrast against the page it sits
  /// on, and the page runs the other way in the other theme. The numbers force
  /// it too — the obvious "lift toward [AppCard.accentStrong]" puts dark on
  /// `#5C7CFF`, where the button's own white label falls to **3.63:1**. These
  /// two hold it at 6.50:1 (light) and 4.76:1 (dark).
  static Color get accentHover =>
      AppTheme.pick(const Color(0xFF2850D8), const Color(0xFF4166F2));

  // "Owner" badge — a teal that stays legible on either surface.
  static Color get teal =>
      AppTheme.pick(const Color(0xFF0F766E), const Color(0xFF2DD4BF));

  // green "connected" dot
  static Color get online =>
      AppTheme.pick(const Color(0xFF15803D), const Color(0xFF3FB950));

  // expiring soon
  static Color get warn =>
      AppTheme.pick(const Color(0xFFB45309), const Color(0xFFFFB020));

  // grey dot
  static Color get offline =>
      AppTheme.pick(const Color(0xFFA3A29C), const Color(0xFF6E6E6E));

  // Grid brand lightning gold — the live/active ⚡ mark, matching the tray bolt.
  static Color get brandBolt =>
      AppTheme.pick(const Color(0xFFC98A00), const Color(0xFFE0A93B));

  static Color get textPrimary =>
      AppTheme.pick(const Color(0xFF1A1A18), const Color(0xFFF5F5F5));

  static Color get textSecondary =>
      AppTheme.pick(const Color(0xFF62615B), const Color(0xFFA8A8A2));

  static Color get textFaint =>
      AppTheme.pick(const Color(0xFF8E8D86), const Color(0xFF6E6E68));

  /// The page a document is drawn on, and the ink on it.
  ///
  /// The one pair here that does **not** follow the app's theme, deliberately: a
  /// page is the *document*, not the app's chrome. Word keeps dark chrome around
  /// white paper for the reason that decides it — what you edit has to look like
  /// what you send, and a page that turned charcoal in dark mode would show the
  /// author a document nobody else will ever see. Named here rather than typed
  /// into the editor so the rule is stated once and the exception is visible
  /// next to the tokens it breaks with.
  /// Both are `const`, and that is the enforcement rather than a note: a
  /// `AppTheme.pick` here would make the page follow Light/Dark, and a value that
  /// cannot be picked cannot drift. Pure black ink, not the app's near-black
  /// [textPrimary] — Word's "automatic" text colour is #000000, and this text is
  /// going to print.
  static const paper = Color(0xFFFFFFFF);
  static const paperInk = Color(0xFF000000);

  /// The furniture *around* the page — the formatting bar and the two rulers.
  ///
  /// Light in both themes, like [paper] above, and for a reason one step on
  /// from it. The page stays white because it is what you send; these stay light
  /// because they are what you set it with, and a ruler mixed for charcoal
  /// while the paper beside it is white belongs to neither. Word and Google Docs
  /// both keep this band light against a dark desk, which is what makes the page
  /// read as a page rather than as a white hole.
  ///
  /// `const` for the same reason [paper] is: a value that cannot be
  /// [AppTheme.pick]ed cannot quietly start following the theme again.
  ///
  /// Measured on [paperChrome]: [paperChromeInk] 11.3:1, [paperChromeInkSoft]
  /// 5.1:1 — both clear §11 with room, which the app's own text tokens would not
  /// have on this surface in dark.
  static const paperChrome = Color(0xFFF2F1ED);

  /// Hairlines, and the ruler's margin band.
  static const paperChromeLine = Color(0xFFD6D5CF);

  /// A pressed toggle, and the lift under a hovered glyph.
  static const paperChromeFill = Color(0xFFE3E2DC);

  /// Labels, glyphs and the ruler's numbers.
  static const paperChromeInk = Color(0xFF33332F);

  /// The resting ink of a control that isn't the one in force.
  static const paperChromeInkSoft = Color(0xFF63625C);

  /// The desk the page sits on.
  ///
  /// It used to follow the theme, and in dark that made it `#141414` — a page
  /// of white paper laid on near-black, which is the harshest edge the app had
  /// and the thing that made this screen tiring to look at. Now that the bar and
  /// the rulers around the page are fixed light, a desk that flipped was also
  /// the one surface still changing theme in the middle of the document, with
  /// chrome above it that didn't.
  ///
  /// So: one warm grey, in both. Deeper than [paperChromeLine] so the desk reads
  /// as *behind* the rulers rather than continuous with them, and far enough
  /// from [paper] that the page keeps its edges — which was the reason the light
  /// value could never be white either.
  static const paperDesk = Color(0xFFC4C3BD);
}

/// The scrollbar thumb, per brightness.
///
/// Kept as plain constants rather than only as [AppSurface] getters because
/// [buildAppTheme] needs the values *before* the global brightness is the one
/// being built for — see the note at its `scrollbarTheme`. The getters below read
/// these same four, so there is one set of numbers rather than two that can drift.
const Color _scrollThumbLight = Color(0xFF8C8C8C);
const Color _scrollThumbDark = Color(0xFF686868);
const Color _scrollThumbHoverLight = Color(0xFF6E6E6E);
const Color _scrollThumbHoverDark = Color(0xFF8A8A8A);

/// Surface tokens for the app's chrome — the sidebar's rows, the composer card,
/// a recessed list column. Depth comes from a hairline rim and a soft shadow; the
/// overlays flip from black (on light) to white (on dark) so a hover/selection is
/// visible on either surface.
abstract final class AppSurface {
  /// The sidebar row you're on.
  static Color get selectedFill =>
      AppTheme.pick(const Color(0x0D000000), const Color(0x14FFFFFF));

  /// The sidebar row under the pointer — lighter than [selectedFill], so hover
  /// never reads as "selected".
  static Color get hoverFill =>
      AppTheme.pick(const Color(0x07000000), const Color(0x0DFFFFFF));

  /// A whisper of the accent, washed under the rail's primary action ("New
  /// chat") so it invites the click without hardening into a button. Kept faint
  /// (~8% in light, a touch stronger in dark so it reads on charcoal).
  static Color get accentWash =>
      AppTheme.pick(const Color(0x142F5BEA), const Color(0x242F5BEA));

  /// The same wash a step stronger, for the primary action under the pointer —
  /// so hovering it still reads as a change without ever looking "selected".
  static Color get accentWashHover =>
      AppTheme.pick(const Color(0x1F2F5BEA), const Color(0x332F5BEA));

  /// The icon well inside a list row.
  ///
  /// Translucent on purpose. An opaque fill would be picked against the row's
  /// *resting* colour and then near-vanish the moment the row lifted on hover —
  /// measured at 1.041:1 against the hovered light row. An overlay rides whatever
  /// it sits on, so the well keeps its edge in both states:
  ///
  /// ```
  ///          rest    hover
  /// light    1.168   1.173
  /// dark     1.183   1.200
  /// ```
  ///
  /// The two themes take different alphas because they start from different
  /// grounds — light needs more to separate from `#F3F3F2` than dark does from
  /// `#202020`. The glyph inside keeps 4.79:1 (light) and 5.76:1 (dark).
  static Color get wellFill =>
      AppTheme.pick(const Color(0x12000000), const Color(0x0FFFFFFF));

  /// A recessed well inside a panel.
  static Color get recess =>
      AppTheme.pick(const Color(0x08000000), const Color(0x0FFFFFFF));

  /// The recessed well under the pointer — a step lighter than [recess], so a
  /// hoverable surface (the account pill) lifts a touch to say it's clickable.
  static Color get recessHover =>
      AppTheme.pick(const Color(0x12000000), const Color(0x1AFFFFFF));

  /// A scrollbar thumb at rest.
  ///
  /// Opaque rather than a wash, and per-brightness rather than one alpha, because
  /// Material's default is neither and lands under the 3:1 that WCAG 1.4.11 asks
  /// of a UI element — `onSurface` at 10% is **1.23:1** on the light page, and at
  /// 30% is **2.46:1** on the dark one. Both were measured; both read as "no
  /// scrollbar" until you look for it.
  ///
  /// One alpha can't fix it either: white lifts a dark page fast while black
  /// barely dents a white one, so reaching 3:1 needs 0.40 in dark and 0.50 in
  /// light. These are those two values resolved — 3.55:1 dark, 3.36:1 light —
  /// stated as colours so a list on the panel measures the same as one on the page.
  static Color get scrollThumb =>
      AppTheme.pick(_scrollThumbLight, _scrollThumbDark);

  /// The thumb under the pointer or mid-drag: the same hue, plainly grabbed.
  static Color get scrollThumbHover =>
      AppTheme.pick(_scrollThumbHoverLight, _scrollThumbHoverDark);

  /// Soft drop shadow that lifts a floating surface (the composer) off the page.
  /// Deeper/darker in dark mode where a light lift would look like a glow.
  static List<BoxShadow> get shadow => AppTheme.pick(
    const [
      BoxShadow(
        color: Color(0x14000000),
        blurRadius: 24,
        offset: Offset(0, 10),
        spreadRadius: -10,
      ),
      BoxShadow(color: Color(0x0A000000), blurRadius: 4, offset: Offset(0, 1)),
    ],
    const [
      BoxShadow(
        color: Color(0x66000000),
        blurRadius: 24,
        offset: Offset(0, 10),
        spreadRadius: -10,
      ),
      BoxShadow(color: Color(0x40000000), blurRadius: 4, offset: Offset(0, 1)),
    ],
  );

  /// The composer's lift — Codex gives its input a soft shadow that spreads wide
  /// and low so the box clearly floats over the transcript. Two layers: a broad
  /// ambient pool plus a tighter contact shadow right under the rim.
  static List<BoxShadow> get composerShadow => AppTheme.pick(
    const [
      BoxShadow(
        color: Color(0x1F000000),
        blurRadius: 28,
        offset: Offset(0, 10),
        spreadRadius: -6,
      ),
      BoxShadow(
        color: Color(0x14000000),
        blurRadius: 8,
        offset: Offset(0, 2),
        spreadRadius: -2,
      ),
    ],
    const [
      BoxShadow(
        color: Color(0x80000000),
        blurRadius: 30,
        offset: Offset(0, 12),
        spreadRadius: -6,
      ),
      BoxShadow(
        color: Color(0x4D000000),
        blurRadius: 10,
        offset: Offset(0, 3),
        spreadRadius: -3,
      ),
    ],
  );
}

/// Translucent Codex-like chrome surfaces used behind a backdrop blur (the
/// sidebar, the top bar, floating pills). Fills are semi-transparent so the blur
/// shows through; kept separate from [AppCard] because these surfaces are chrome,
/// not dense content cards.
abstract final class AppGlass {
  // Near-opaque so the rail reads as a calm flat surface, not a frosted panel.
  //
  // Dark is fully opaque and says the value it means. Nothing is blurred behind
  // the rail (see [AppSidebar]), so the alpha did one thing: pull the fill 6%
  // back towards the page under it and land the rail on #191919 rather than the
  // number written here — a token that could only be read by compositing it.
  // At #242424 the rail is 1.27:1 against the page, so it reads as a surface
  // the content lies beside rather than the same charcoal with a hairline on it.
  static Color get sidebarFill =>
      AppTheme.pick(const Color(0xF7F9F9F8), const Color(0xFF242424));

  // Pills/menus are solid white in Codex (their softness comes from the rim and
  // a whisper of shadow, not from translucency).
  static Color get surfaceFill =>
      AppTheme.pick(const Color(0xFFFFFFFF), const Color(0xFF202020));

  static Color get surfaceHoverFill =>
      AppTheme.pick(const Color(0xFFF7F7F6), const Color(0xFF272727));

  static Color get hair =>
      AppTheme.pick(const Color(0x14000000), const Color(0x1FFFFFFF));

  /// A more present rim for the surfaces that should read as *lifted* — the
  /// composer, above all. The plain [hair] disappears into a white pane; this one
  /// is a clear soft grey (~#DADADA on white) so the input keeps a visible edge
  /// like Codex, without hardening into a boxy outline.
  static Color get lift =>
      AppTheme.pick(const Color(0x2E000000), const Color(0x2EFFFFFF));

  static Color get bubbleFill =>
      AppTheme.pick(const Color(0xFFF3F3F1), const Color(0xFF242424));

  static List<BoxShadow> get shadow => AppTheme.pick(
    const [
      BoxShadow(
        color: Color(0x14000000),
        blurRadius: 16,
        offset: Offset(0, 6),
        spreadRadius: -6,
      ),
      BoxShadow(color: Color(0x0A000000), blurRadius: 2, offset: Offset(0, 1)),
    ],
    const [
      BoxShadow(
        color: Color(0x66000000),
        blurRadius: 18,
        offset: Offset(0, 7),
        spreadRadius: -7,
      ),
      BoxShadow(color: Color(0x33000000), blurRadius: 3, offset: Offset(0, 1)),
    ],
  );

  // A whisper — the soft, tight lift Codex gives its floating pills and menus,
  // not a big ambient drop.
  /// A list row sitting directly on the page, at rest.
  ///
  /// **Not [surfaceFill], and light is the whole reason.** `windowBg` in light is
  /// pure `#FFFFFF` and so is `surfaceFill`, which put the row and the page it
  /// sits on at **1.000:1** — the same colour. The list had no rows in light at
  /// all until the pointer moved over one, because `surfaceHoverFill` (`#F7F7F6`,
  /// 1.072:1) was the first fill that differed from the page.
  ///
  /// A raised block cannot be raised by fill on a pure-white page: lighter than
  /// white does not exist. So light recesses instead — a grey card on white, the
  /// ordinary light-UI idiom — while dark keeps lifting. Measured, and shaped to
  /// match dark's separation rather than guessed at:
  ///
  /// ```
  ///           rest      hover     hover vs rest
  /// dark      1.090     1.189     1.091
  /// light     1.110     1.205     1.086
  /// ```
  ///
  /// Light's rest is [AppPalette.cardBg] rather than a new colour; only the hover
  /// step needed one. Text keeps its room on both: `textSecondary` reads 5.60:1
  /// at rest and 5.15:1 hovered.
  static Color get rowFill =>
      AppTheme.pick(const Color(0xFFF3F3F2), const Color(0xFF202020));

  /// The same row under the pointer.
  ///
  /// Moves *away* from the page in both themes — darker in light, lighter in dark
  /// — because a hover that drifts toward the background erases the row it is
  /// meant to be highlighting.
  static Color get rowHoverFill =>
      AppTheme.pick(const Color(0xFFEAEAE7), const Color(0xFF272727));

  static List<BoxShadow> get cardShadow => AppTheme.pick(
    const [
      BoxShadow(
        color: Color(0x0F000000),
        blurRadius: 8,
        offset: Offset(0, 3),
        spreadRadius: -3,
      ),
      BoxShadow(color: Color(0x08000000), blurRadius: 1, offset: Offset(0, 1)),
    ],
    const [
      BoxShadow(
        color: Color(0x59000000),
        blurRadius: 10,
        offset: Offset(0, 4),
        spreadRadius: -4,
      ),
    ],
  );
}

/// The floating-panel recipe — **one** source for every menu, popover and
/// tooltip in the app, so the three cannot drift apart.
///
/// They already had. Before this the app carried *four* recipes for the same
/// surface, and no two agreed:
///
/// ```
///                              fill (dark)   elevation   radius   rim
///   menuTheme / popupMenuTheme   #1E1E1E         8          6      no
///   appMenuStyle()               #2A2A2A        12         10      yes
///   tooltipTheme                 #1E1E1E         —         10      yes
///   AccountFooter, inline        cardBg         18          8      yes
/// ```
///
/// The cost was exactly what a second recipe always costs: the account footer's
/// `MenuAnchor` passed no style at all, so it opened the rimless themed default
/// — the surface `appMenuStyle` had been written to replace.
///
/// ⚠️ The fill is deliberately **not** the themed default. `#1E1E1E` sits within
/// 1.02:1 of a raised block ([AppGlass.surfaceFill], `#202020`), and in light
/// both are pure white — a menu opened over a dialog then has no edge at all and
/// its rows appear to float loose on the page. These lift clear of *both*
/// grounds a menu can open over: the page (`#181818` / `#FFFFFF`) and that
/// block. Measured with `tool/contrast.py`, 2026-09-03:
///
/// ```
///   dark   panel #2A2A2A vs page  #181818  =  1.237 : 1
///   dark   panel #2A2A2A vs block #202020  =  1.135 : 1
///   light  panel #FFFFFF vs page  #FFFFFF  =  1.000 : 1   ← the rim does it
///   light  panel #FFFFFF vs block #FFFFFF  =  1.000 : 1   ← and here
/// ```
///
/// Light is why the rim exists. On a white page the panel and the ground under
/// it are *the same colour*, so the rim is the only thing drawing the edge —
/// which is what earns it the one exception §1 allows. Fill alone cannot
/// separate two surfaces (§9.1); the rim and the shadow do it together, which is
/// also why the rim is not held to §16's 3.0 — see the note in `contrast.py`.
///
/// ⚠️ These are measurements with a date. Move `windowBg` or `surfaceFill` and
/// all four are stale — re-run the script, don't trust the comment.
///
/// ⚠️ The `*Light`/`*Dark` const twins exist for the same reason `_scrollThumb*`
/// do: [buildAppTheme] builds a theme for a brightness it has been *handed*,
/// while a getter answers for the brightness the app is *wearing*, and the two
/// differ in exactly the call that produces `darkTheme`. Inside that function
/// use [styleFor] and the consts; everywhere else use [style] and the getters.
abstract final class AppMenu {
  static const Color fillLight = Color(0xFFFFFFFF);
  static const Color fillDark = Color(0xFF2A2A2A);
  static Color get fill => AppTheme.pick(fillLight, fillDark);

  /// The panel's rim — the same hairline [AppGlass.hair] resolves to, stated as
  /// consts so [buildAppTheme] can read it.
  static const Color rimLight = Color(0x14000000);
  static const Color rimDark = Color(0x1FFFFFFF);
  static Color get rim => AppTheme.pick(rimLight, rimDark);

  /// A menu panel's rounding. On the §3 ladder this is the *panel* step (10),
  /// one below a content card (12) and above the rows inside it (8) — a child is
  /// never rounder than its parent.
  static const double panelRadius = 10;

  /// Deeper than Material's menu default (8): this panel opens over chrome that
  /// already carries a lift of its own, and at 8 it reads as lying *on* that
  /// chrome rather than over it.
  static const double elevation = 12;

  /// ⚠️ Vertical only. Rows carry their own horizontal gutter so their hover
  /// highlight reads as an inset pill; side padding here would double it.
  static const EdgeInsets panelPadding = EdgeInsets.symmetric(vertical: 5);

  /// The style every menu panel in the app takes.
  ///
  /// [minWidth]/[maxWidth] are for a panel whose width is part of its meaning —
  /// the account menu holds an email address and must not resize as the address
  /// changes. [maxHeight] defaults to [AppControl.menuMaxHeight]; override it
  /// only for a panel that is taller by design, and read that token's note
  /// first: a menu that opens *upward* places itself by summing the height it is
  /// about to take.
  static MenuStyle style({
    double? minWidth,
    double? maxWidth,
    double? maxHeight,
  }) => _style(
    isDark: AppTheme.isDark,
    minWidth: minWidth,
    maxWidth: maxWidth,
    maxHeight: maxHeight,
  );

  /// [style] resolved against a brightness handed in rather than the one the app
  /// is wearing. Only [buildAppTheme] needs this — see the ⚠️ above.
  static MenuStyle styleFor({required bool isDark}) => _style(isDark: isDark);

  static MenuStyle _style({
    required bool isDark,
    double? minWidth,
    double? maxWidth,
    double? maxHeight,
  }) => MenuStyle(
    backgroundColor: WidgetStatePropertyAll(isDark ? fillDark : fillLight),
    surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
    elevation: const WidgetStatePropertyAll(elevation),
    padding: const WidgetStatePropertyAll(panelPadding),
    minimumSize: minWidth == null
        ? null
        : WidgetStatePropertyAll(Size(minWidth, 0)),
    maximumSize: WidgetStatePropertyAll(
      Size(maxWidth ?? double.infinity, maxHeight ?? AppControl.menuMaxHeight),
    ),
    shape: WidgetStatePropertyAll(
      RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(panelRadius),
        side: BorderSide(color: isDark ? rimDark : rimLight),
      ),
    ),
  );
}

/// Content-card recipe — a surface with a hairline rim and a soft lift. Distinct
/// from [AppSurface] (the chrome): cards carry dense content, so they stay quiet
/// and let the text do the work. Applied via [GlassCard].
abstract final class AppCard {
  static const accent = AppPalette.accent;
  static Color get accentStrong =>
      AppTheme.pick(const Color(0xFF1E40AF), const Color(0xFF5C7CFF));

  // card surface
  static Color get base =>
      AppTheme.pick(const Color(0xFFFFFFFF), const Color(0xFF1E1E1E));

  // recessed inner box / list tile
  static Color get inset =>
      AppTheme.pick(const Color(0xFFF7F7F5), const Color(0xFF181818));

  static Color get hair => AppPalette.divider; // card rim
  static Color get insetHair =>
      AppTheme.pick(const Color(0x0F000000), const Color(0x14FFFFFF));

  // Accent tints — used sparingly, for the focal card's wash and rim. Slightly
  // stronger in dark so the wash reads on charcoal.
  static Color get tint10 =>
      AppTheme.pick(const Color(0x0A2F5BEA), const Color(0x1A2F5BEA));
  static Color get tint18 =>
      AppTheme.pick(const Color(0x142F5BEA), const Color(0x282F5BEA));
  static Color get tint25 =>
      AppTheme.pick(const Color(0x332F5BEA), const Color(0x422F5BEA));

  static Color get highlightEdge =>
      AppTheme.pick(const Color(0x0A000000), const Color(0x1FFFFFFF));

  /// Corner rounding, on macOS's scale rather than iOS's.
  ///
  /// A Mac window is ~10 and a sheet/popover ~12; iOS and the web round far
  /// harder, and at 18 a card read as an iOS sheet that had wandered onto a
  /// desktop. It also disagreed with the buttons *inside* it ([AppControl.radius]
  /// is 8), so a card and its own action were speaking two shape languages.
  ///
  /// The inset tile drops to 8 to match those buttons: an inset sits inside a
  /// card, and nesting a rounder box inside a less-round one is what makes a
  /// tile look pasted on rather than set in.
  static const double radius = 12;
  static const double insetRadius = 8;

  /// Soft ambient drop that lifts a card off the page.
  static List<BoxShadow> get shadow => AppTheme.pick(
    const [
      BoxShadow(
        color: Color(0x12000000),
        blurRadius: 20,
        offset: Offset(0, 8),
        spreadRadius: -8,
      ),
    ],
    const [
      BoxShadow(
        color: Color(0x66000000),
        blurRadius: 20,
        offset: Offset(0, 8),
        spreadRadius: -8,
      ),
    ],
  );

  /// The focal (hero) card's stronger lift.
  static List<BoxShadow> get heroShadow => AppTheme.pick(
    [
      const BoxShadow(
        color: Color(0x1A000000),
        blurRadius: 28,
        offset: Offset(0, 12),
        spreadRadius: -8,
      ),
      BoxShadow(
        color: tint18,
        blurRadius: 32,
        offset: const Offset(0, 10),
        spreadRadius: -8,
      ),
    ],
    [
      const BoxShadow(
        color: Color(0x73000000),
        blurRadius: 28,
        offset: Offset(0, 12),
        spreadRadius: -8,
      ),
      BoxShadow(
        color: tint18,
        blurRadius: 32,
        offset: const Offset(0, 10),
        spreadRadius: -8,
      ),
    ],
  );
}

/// The app's theme for a given [brightness]. Both the light and dark themes are
/// built from this one function so the two never drift; the color tokens above
/// resolve against [AppTheme.brightness] at paint time.
ThemeData buildAppTheme({Brightness brightness = Brightness.light}) {
  final isDark = brightness == Brightness.dark;
  final scheme = isDark
      ? const ColorScheme.dark(
          primary: AppPalette.accent,
          onPrimary: Colors.white,
          secondary: AppPalette.accent,
          surface: Color(0xFF181818),
          onSurface: Color(0xFFF5F5F5),
          onSurfaceVariant: Color(0xFFA8A8A2),
          surfaceContainerHighest: Color(0xFF1E1E1E),
          outline: Color(0x14FFFFFF),
          outlineVariant: Color(0x14FFFFFF),
          error: Color(0xFFF2544B),
        )
      : const ColorScheme.light(
          primary: AppPalette.accent,
          onPrimary: Colors.white,
          secondary: AppPalette.accent,
          // Pure white — matches AppPalette.windowBg so the chat pane (which
          // paints scheme.surface) reads as clean white, letting the composer's
          // rim and shadow stand out instead of blending into an off-white wash.
          surface: Color(0xFFFFFFFF),
          onSurface: Color(0xFF1A1A18),
          onSurfaceVariant: Color(0xFF62615B),
          surfaceContainerHighest: Color(0xFFF3F3F2),
          outline: Color(0x0F000000),
          outlineVariant: Color(0x0F000000),
          error: Color(0xFFB3261E),
        );

  // The chrome fills used by menus, dialogs and toasts. A getter-backed token
  // can't be a compile-time const, so these are resolved here per-brightness —
  // and, more importantly, from `isDark` rather than off a token, for the reason
  // spelled out at `scrollbarTheme` below.
  //
  // Two fills, not one. A *floating panel* (menu, popover, tooltip) opens over
  // chrome that may itself be raised, so it takes [AppMenu]'s lifted fill; a
  // *dialog* is the raised block, so it takes the block's own fill. Before this
  // both were `#1E1E1E`, which is [AppCard.base] — a content card's colour, one
  // step *below* the block it was supposed to be.
  final panelFill = isDark ? AppMenu.fillDark : AppMenu.fillLight;
  final dialogFill = isDark ? const Color(0xFF202020) : const Color(0xFFFFFFFF);
  final textTheme = _appTextTheme(scheme.onSurface, scheme.onSurfaceVariant);

  return ThemeData(
    filledButtonTheme: FilledButtonThemeData(style: _filledButtonStyle()),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: _outlinedButtonStyle(scheme),
    ),
    textButtonTheme: TextButtonThemeData(style: _textButtonStyle()),
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    // Also stated at ThemeData level, not only inside the ramp: Material builds
    // text of its own (a dialog's semantics label, a field's error line) that
    // never passes through `textTheme`, and without this those fall through to
    // Roboto — one stray face in an app drawn entirely in San Francisco.
    fontFamily: AppFont.sans,
    fontFamilyFallback: AppFont.sansFallback,
    scaffoldBackgroundColor: scheme.surface,
    canvasColor: scheme.surface,
    dividerColor: scheme.outline,
    dividerTheme: DividerThemeData(
      color: scheme.outline,
      thickness: 1,
      space: 1,
    ),
    // Set once here rather than per-Scrollbar: the three call sites that predate
    // this each accepted Material's default, which measures 1.23:1 on the light
    // page and 2.46:1 on the dark one — under the 3:1 floor for a UI element.
    // See `AppSurface.scrollThumb` for the numbers.
    scrollbarTheme: ScrollbarThemeData(
      // Resolved from `isDark`, not read off `AppSurface` — this function is
      // called twice up front, and the dark pass runs while the global
      // brightness still says light, so a getter-backed token would bake the
      // light thumb into `darkTheme`. The `AppPalette.accent` reads above never
      // exposed this: that one is a const with the same value in both themes.
      thumbColor: WidgetStateProperty.resolveWith(
        (states) =>
            states.contains(WidgetState.hovered) ||
                states.contains(WidgetState.dragged)
            ? (isDark ? _scrollThumbHoverDark : _scrollThumbHoverLight)
            : (isDark ? _scrollThumbDark : _scrollThumbLight),
      ),
      // No track: a filled channel down the edge of every pane is a border by
      // another name, and §2 allows exactly one of those.
      trackColor: WidgetStateProperty.all(Colors.transparent),
      trackBorderColor: WidgetStateProperty.all(Colors.transparent),
      // 6px, radius 3 — a thin capsule rather than the 8px slab, which at this
      // contrast would read as a chrome element competing with the rows.
      thickness: WidgetStateProperty.all(6),
      radius: const Radius.circular(3),
      // The thumb is only meaningful while there is more list than pane, and
      // fading it in on scroll keeps a short list from wearing furniture.
      thumbVisibility: WidgetStateProperty.all(false),
      interactive: true,
    ),
    // Material opens a tooltip the instant the pointer enters. In a transcript
    // that scrolls under a still pointer that means tooltips popping open on
    // rows flying past — and worse: a tooltip shown mid-scroll gets its overlay
    // hit-tested before it has been laid out, which throws inside the mouse
    // tracker and then re-throws every frame after (see ErrorBurstFilter). A
    // delay is the fix for both, set once here rather than at the nine call
    // sites that each reached for their own number.
    //
    // Everything below the delay is the app's floating-panel recipe, the same
    // one `appMenuStyle` uses, because a tooltip is one: the menu fill, the
    // hairline rim, the panel radius and the lift. Material's own is an
    // *inverse* surface — deliberately the opposite of the window — so on a dark
    // build it opened a white slab in the middle of a near-black app.
    //
    // The rim earns its place here for the reason it does on a menu: in light
    // the fill is the same white as the surface underneath, so the rim is the
    // only thing drawing the edge, and in dark it firms up a lift that a shadow
    // alone renders too softly against near-black.
    tooltipTheme: TooltipThemeData(
      waitDuration: const Duration(milliseconds: 500),
      decoration: BoxDecoration(
        color: panelFill,
        borderRadius: BorderRadius.circular(AppMenu.panelRadius),
        // Resolved from `isDark` rather than read off the `AppMenu` getters:
        // those answer for the brightness the app is *showing*, and this function
        // builds the theme for a brightness it has been handed.
        border: Border.all(color: isDark ? AppMenu.rimDark : AppMenu.rimLight),
        boxShadow: isDark
            ? const [
                BoxShadow(
                  color: Color(0x66000000),
                  blurRadius: 24,
                  offset: Offset(0, 10),
                  spreadRadius: -10,
                ),
                BoxShadow(
                  color: Color(0x40000000),
                  blurRadius: 4,
                  offset: Offset(0, 1),
                ),
              ]
            : const [
                BoxShadow(
                  color: Color(0x14000000),
                  blurRadius: 24,
                  offset: Offset(0, 10),
                  spreadRadius: -10,
                ),
                BoxShadow(
                  color: Color(0x0A000000),
                  blurRadius: 4,
                  offset: Offset(0, 1),
                ),
              ],
      ),
      // A step under the control font: a tooltip is read *while* looking at the
      // thing it explains, so it should not compete with it. The line height is
      // for the long ones — a run of selections is several lines of quoted code,
      // and set solid it reads as a wall.
      textStyle: TextStyle(
        fontSize: 12.5,
        height: 1.45,
        color: scheme.onSurface,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      // Long quoted lines would otherwise take the tooltip out to the window's
      // full width — a panel wider than the conversation it is explaining.
      constraints: const BoxConstraints(maxWidth: 420),
    ),
    // macOS controls do not ripple. §10.1 lists the ink ripple among the four
    // things a raw `MenuItemButton` gets wrong, and §11 names it again for
    // `IconButton` and `SegmentedButton` — so turning it off once here is the
    // same rule applied at the root instead of at every call site.
    splashFactory: NoSplash.splashFactory,
    textTheme: textTheme,
    primaryTextTheme: textTheme,
    iconTheme: IconThemeData(color: scheme.onSurfaceVariant, size: 18),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.all(Colors.white),
      trackColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected)
            ? AppPalette.accent
            : (isDark ? const Color(0xFF3A3A3A) : const Color(0xFFA3A29C)),
      ),
      trackOutlineColor: WidgetStateProperty.all(Colors.transparent),
    ),
    // A text field must show where the keyboard is going. This used to set
    // BorderSide.none on all three states, so every field that took the theme
    // default — most of the app — had no focus ring at all: you could not tell
    // a focused field from an idle one. macOS rings the focused control in the
    // accent; that's what these borders restore.
    inputDecorationTheme: InputDecorationTheme(
      isDense: true,
      filled: true,
      fillColor: scheme.surfaceContainerHighest,
      // A field is a control, so its hint takes the control font — 13pt, the
      // same as the button beside it. (The typed text is set on the field via
      // [kFieldTextStyle]; `InputDecorationTheme` has no `style` of its own, so
      // a field's own text can't be themed globally here.)
      hintStyle: _fieldTextStyle(
        scheme.onSurfaceVariant.withValues(alpha: 0.7),
      ),
      // Material builds a field for a phone: its default padding, plus the 48px
      // touch target it gives a prefixIcon, rendered this 48 tall next to a 32px
      // button. That's what these constraints exist to hold back.
      //
      // The height is [AppControl.heightField], not [AppControl.height]: a field
      // is typed in, not clicked, and at a button's 32 it reads cramped — see
      // that token. Derived here rather than typed as a number that happens to
      // land near it.
      //
      // The arithmetic: the box is padding + one line of AppControl.fontSize.
      // `isDense` already tightens Material's own vertical slack, so the padding
      // is what's left over once the line has taken its share.
      constraints: BoxConstraints(minHeight: AppControl.heightFieldScaled),
      contentPadding: EdgeInsets.symmetric(
        horizontal: 10,
        vertical:
            (AppControl.heightFieldScaled -
                AppControl.fontSize * 1.35 * AppFont.uiScale) /
            2,
      ),
      // The glyph sits on the text's line, not in a tap target of its own. A
      // step above [AppControl.iconSize]: that size is tuned to a button's cap
      // height, and this field is taller, so the button's glyph looks
      // undersized in it.
      prefixIconConstraints: BoxConstraints(
        minWidth: 32 * AppFont.uiScale,
        minHeight: kFieldIconSize * AppFont.uiScale,
      ),
      border: _fieldBorder(scheme.outline),
      enabledBorder: _fieldBorder(scheme.outline),
      focusedBorder: _fieldBorder(AppPalette.accent, width: 1.5),
      errorBorder: _fieldBorder(scheme.error),
      focusedErrorBorder: _fieldBorder(scheme.error, width: 1.5),
    ),
    // Fill, rim and elevation come from [AppMenu] so a Material popup cannot
    // disagree with a MenuAnchor about what a menu looks like.
    //
    // The radius does not: [AppControl.menuRadius] (6) is the §3 step for
    // *Material's own* popup, which draws tighter than the app's panel (10).
    popupMenuTheme: PopupMenuThemeData(
      color: panelFill,
      surfaceTintColor: Colors.transparent,
      elevation: AppMenu.elevation,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppControl.menuRadius),
        side: BorderSide(color: isDark ? AppMenu.rimDark : AppMenu.rimLight),
      ),
    ),
    // The default every `MenuAnchor` gets, identical to what [AppMenu.style]
    // hands a call site that asks for one explicitly. That identity is the whole
    // point: a MenuAnchor that forgets to pass a style used to fall back to a
    // rimless panel, which is the bug the hand-written style existed to fix.
    menuTheme: MenuThemeData(style: AppMenu.styleFor(isDark: isDark)),
    // An ExpansionTile defaults `backgroundColor` (expanded) and
    // `collapsedBackgroundColor` to *different* values and cross-fades between
    // them, so opening one flashes a tint over whatever surface it sits on. Our
    // tiles are always laid into a card that has already painted its own
    // background, so both states must simply be transparent — then expanding
    // moves the disclosure and nothing else.
    expansionTileTheme: const ExpansionTileThemeData(
      backgroundColor: Colors.transparent,
      collapsedBackgroundColor: Colors.transparent,
      // Same reason for the divider lines each tile was clearing by hand.
      shape: Border(),
      collapsedShape: Border(),
    ),
    dialogTheme: DialogThemeData(
      // The raised block's own fill, not a menu's and not a card's. §9.3: a
      // dialog that takes `windowBg` merges with the page, and one that takes
      // [AppCard.base] sits a step under the block it is supposed to *be* —
      // both invisible in light, both plain in dark.
      backgroundColor: dialogFill,
      surfaceTintColor: Colors.transparent,
      // The card radius, not a number of its own. This was 18 — the iOS
      // action-sheet curve, and the app's cards had already come down to 12 for
      // macOS without the dialogs following.
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppCard.radius),
      ),
    ),
    // ⚠️ [AppPalette.accentOnSurface], NOT `colorScheme.primary`.
    //
    // A spinner is the textbook case that token exists for: a MARK ON A SURFACE,
    // not a fill carrying white text. Left to `primary` the arc draws #2F5BEA on
    // the dark page, which measures 3.218:1 — over §16's 3.0 floor for a UI
    // element, but only just, and it is the one thing on screen saying the app
    // is still working. The lifted tint reaches 5.750:1.
    //
    // Resolved from `isDark` rather than read off the getter — see the note at
    // `scrollbarTheme`.
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: isDark ? const Color(0xFF6E8BFF) : const Color(0xFF2F5BEA),
      linearTrackColor: scheme.outline,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      width: 520,
      // A snackbar floats over everything, so it takes the panel fill.
      backgroundColor: panelFill,
      contentTextStyle: TextStyle(
        color: scheme.onSurface,
        fontSize: 13.5,
        fontWeight: FontWeight.w600,
      ),
      actionTextColor: AppPalette.accent,
      closeIconColor: scheme.onSurfaceVariant,
      elevation: 10,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
    ),
  );
}

/// The one set of numbers every button in the app is built from.
///
/// macOS controls are compact, squarish and quiet: a 13pt semibold label in a
/// ~32px capsule with a small radius — not the tall, wide, fully-round buttons
/// Material defaults to. Before this existed each call site invented its own,
/// which is how the app ended up with seven button heights, three shape systems
/// and six label sizes. Change a number here, not at a call site.
abstract final class AppControl {
  /// Standard control height. macOS's regular push button sits at 32; the app's
  /// own most-used value was 34, and 32 reads correctly next to a 13pt label.
  static const double height = 32;

  /// A compact control (inline actions inside a dense row or a card header).
  static const double heightSmall = 28;

  /// A search field at the head of a list column.
  ///
  /// Taller than [height], and deliberately: a push button is sized to be hit,
  /// but this field is sized to be *typed in* and to anchor the column under it.
  /// Finder and Mail both give their sidebar search more room than a button in
  /// the same window for exactly that reason — at [height] it reads as cramped,
  /// which is what a control set to a button's scale looks like when it isn't
  /// one.
  static const double heightField = 36;

  /// Corner radius. Apple's push buttons are gently rounded, not stadium — a
  /// pill reads as a "chip" on macOS, not as a button.
  static const double radius = 8;

  /// A menu/popover's rounding. Tighter than a button's: macOS menus are nearly
  /// square-cornered, and rounding one like an iOS action sheet is one of the
  /// louder tells that a desktop app was drawn to phone conventions.
  static const double menuRadius = 6;

  /// The air between a menu panel and the control it hangs off.
  ///
  /// One number for every menu in the app, in both directions: a downward menu
  /// passes `Offset(0, menuGap)`, an upward one `Offset(0, -menuGap)`. It was
  /// three numbers before — 6 nearly everywhere, 8 on the composer's agent and
  /// approval pills, and none at all on its model pill, so the three menus that
  /// open off the *same* toolbar each sat at a different height.
  static const double menuGap = 6;

  /// The tallest a menu panel ever draws, whatever it lists — `appMenuStyle`
  /// caps every menu here.
  ///
  /// A token rather than a number inside that style, because the menus that
  /// open *upward* have to place themselves by summing the height they are
  /// about to take: a caller that predicts 310 for a panel the style then draws
  /// at 240 lifts it 70px clear of its button. That is what floated the chat
  /// model list off the composer and over the conversation.
  /// [anchoredMenuPosition] clamps to this by default.
  static const double menuMaxHeight = 240;

  /// The label. 13pt medium is the macOS control font — Apple sets a push
  /// button's label at medium, not semibold; at 13pt the extra step reads as a
  /// button trying to be a heading.
  static const double fontSize = 13;
  static const FontWeight fontWeight = AppFont.medium;

  /// A leading glyph inside a button, sized to sit on the cap height of a 13pt
  /// label rather than tower over it.
  static const double iconSize = 16;

  /// The glyph on a chip — an inline affordance whose label runs smaller than a
  /// button's (11pt, not 13). [iconSize] is cut to a 13pt cap height and towers
  /// over an 11pt one, so a chip needs its own step down rather than a number
  /// picked by eye at each call site.
  static const double iconSizeChip = 13;

  /// Horizontal breathing room. Apple pads a push button generously sideways and
  /// barely at all vertically — the height is what sets the touch target.
  static const EdgeInsets padding = EdgeInsets.symmetric(horizontal: 14);
  static const EdgeInsets paddingSmall = EdgeInsets.symmetric(horizontal: 10);

  /// A button that leads with a glyph, at the compact scale.
  ///
  /// Wider on the leading edge than the trailing one, and the asymmetry is the
  /// point: [paddingSmall] is even, which measures as centred and *reads* as
  /// pushed left. A glyph is a solid shape that fills its box to the edge, while
  /// a label's first letter carries its own sidebearing — so at an equal 10px
  /// the glyph sits visibly tighter to the rim than the text does at the other
  /// end. Extra leading pad buys back what the glyph lacks.
  ///
  /// Only for `.icon` constructors; a text-only button stays on [paddingSmall].
  static const EdgeInsets paddingSmallIcon = EdgeInsets.only(
    left: 12,
    right: 10,
  );

  // — the same numbers, grown with the user's UI size —
  //
  // The constants above stay constants on purpose. They appear in ~40 `const`
  // expressions across the app (`const Size(0, AppControl.height)`, `const
  // Icon(…, size: AppControl.iconSize)`), and turning them into getters would
  // break every one of those for no gain: a `const Icon` inside a themed button
  // is already re-laid-out when the button's own box grows.
  //
  // What actually has to grow is the *box*, and every box in the app comes from
  // one of the button/field styles built below in [buildAppTheme] — so these
  // scaled forms are read there, in one place, rather than at the call sites.

  /// [height], grown for the current UI size.
  static double get heightScaled => height * AppFont.uiScale;

  /// [heightField], grown for the current UI size.
  static double get heightFieldScaled => heightField * AppFont.uiScale;

  /// [padding], grown for the current UI size — a wider label needs the
  /// sidebearing to grow with it, or the text crowds the capsule's ends.
  static EdgeInsets get paddingScaled =>
      EdgeInsets.symmetric(horizontal: 14 * AppFont.uiScale);

  static EdgeInsets get paddingSmallScaled =>
      EdgeInsets.symmetric(horizontal: 10 * AppFont.uiScale);

  // [fontSize] deliberately has no scaled twin. The label inside a button is a
  // `Text`, so `MediaQuery`'s text scaler already grows it — scaling the
  // theme's `textStyle` too would apply the user's setting twice, and a button
  // set to 19px would render at ~26. The boxes above scale; the type does not.
}

/// How long the app's UI takes to change, and on what curve.
///
/// These aren't new numbers — they're the ones already in use, given a name. The
/// app had settled on ~130ms for a hover and `Curves.easeOut` almost everywhere
/// (31 call sites against 8 for the next most common), but every one of them
/// typed the number in by hand, and the drift had already started: 120, 130, 140
/// and 160 all appear for the same kind of change. A tile in Plugins even
/// carries a comment saying its timing "matches the job list's, so a row lifts
/// the same way everywhere in the app" — an intent with nothing enforcing it.
///
/// Motion here is for *continuity*, not decoration: it says the thing you're
/// looking at is the same thing it was a moment ago. That's why it's this short.
/// Anything long enough to notice as an animation is too long for a hover.
abstract final class AppMotion {
  /// A surface reacting to the pointer — a row's hover fill, a chip warming up.
  static const Duration hover = Duration(milliseconds: 130);

  /// Content being replaced in place: a list swapping to another set of rows.
  static const Duration swap = Duration(milliseconds: 160);

  /// A panel folding or unfolding — the sidebar collapsing to its glyphs.
  ///
  /// Longer than [swap], and it has to be: what moves is the window's left
  /// edge and everything to the right of it, over 212px. At [swap] that reads
  /// as the layout jumping rather than the rail folding, which is the one thing
  /// the animation exists to prevent.
  static const Duration fold = Duration(milliseconds: 220);

  /// A meter filling to the figure beside it — the node panel's speed bars.
  ///
  /// Longer than [fold] even though what moves is 26px, because this one is not
  /// a surface getting out of the way: it is a value being drawn, and a reader
  /// is meant to watch it arrive. Under about a quarter second the bars read as
  /// having simply appeared at their length, which is the same as no animation
  /// at all.
  ///
  /// Still short enough to survive repetition. These panels open on hover, so
  /// the fill replays every time the pointer crosses the pill — anything that
  /// lingers turns into a toll on a gesture people make dozens of times an hour.
  static const Duration meter = Duration(milliseconds: 300);

  /// A surface acknowledging a click while the button is still down.
  ///
  /// Shorter than [hover], and it has to be: hover follows a pointer that is
  /// merely passing, while this one answers a press the user is *making*. A
  /// dip that outlasts the click reads as lag in the click itself. Four call
  /// sites had already converged on this number by hand before it had a name.
  static const Duration press = Duration(milliseconds: 110);

  /// The app's curve. Fast to start, settling at the end — the thing arrives
  /// under the pointer rather than drifting toward it.
  static const Curve curve = Curves.easeOut;
}

/// The app's two font stacks, and the rule for which one a given piece of text
/// gets.
///
/// The rule: **mono is for strings the user copies, not for strings they read.**
/// A model id, an endpoint, a token — those need `l`/`1`/`I` and `0`/`O` to stay
/// apart, because the user is going to paste them somewhere that cares. Prose
/// (a heading, a subtitle, a node's name) is *read*, and mono makes reading it
/// slower while making the surface look like a terminal instead of a product.
///
/// Numbers are the case that looks like it wants mono but doesn't: what a stat
/// actually needs is digits that don't reflow when the value changes, and
/// [tabularFigures] buys exactly that on the sans stack — no terminal costume
/// required.
abstract final class AppFont {
  /// The reading stack — matches the text theme's system font.
  ///
  /// A getter, not a const: the user can put a family of their own in front of
  /// it from Appearance, and a `const` can't be re-resolved. [sansDefault] is
  /// the shipped value, still a const, and still what everything falls back to.
  static String get sans => _uiFamily ?? sansDefault;

  /// The shipped reading face, per platform.
  ///
  /// A getter now, because the shipped value is not one name: nothing in the
  /// Apple stack resolves on Linux, so the app was drawn in the engine's own
  /// default rather than a face anyone chose.
  ///
  /// `Ubuntu Sans` (25.04 and later) and `Ubuntu` (before it) lead because they
  /// are what the desktop itself is set in. Measured on Ubuntu 26.04 they do
  /// not currently resolve either — both are two-axis variable fonts
  /// (`wdth,wght`) and measure identically to a family that does not exist,
  /// while the single-axis `Ubuntu Sans Mono` resolves fine — so today the
  /// effective face is `Noto Sans`, the next entry. They stay in front because
  /// they cost nothing and are the right answer the moment the engine can
  /// reach them; `Noto Sans` and `DejaVu Sans` are what actually carries it.
  static String get sansDefault =>
      Platform.isMacOS ? _macSansDefault : _linuxSansDefault;

  static const String _macSansDefault = '.AppleSystemUIFont';
  static const String _linuxSansDefault = 'Ubuntu Sans';

  /// The fallbacks behind [sans].
  ///
  /// When the user has chosen a family, the *system* font goes to the front of
  /// this list rather than being dropped: a chosen face is usually a display or
  /// text font with a partial repertoire, and one missing glyph should degrade
  /// to SF Pro — the thing the app was drawn in — rather than to Arial or to a
  /// row of tofu boxes.
  static List<String> get sansFallback => _uiFamily == null
      ? _sansFallbackDefault
      : [sansDefault, ..._sansFallbackDefault];

  static List<String> get _sansFallbackDefault =>
      Platform.isMacOS ? _macSansFallback : _linuxSansFallback;

  static const List<String> _macSansFallback = [
    'SF Pro Text',
    'Helvetica Neue',
    'Arial',
  ];

  static const List<String> _linuxSansFallback = [
    'Ubuntu',
    'Noto Sans',
    'DejaVu Sans',
    'sans-serif',
  ];

  /// The copy-me stack: SF Mono, the system's own code face.
  ///
  /// The name matters. `'SF Mono'` does **not** resolve — CoreText returns nil
  /// for it, so Flutter quietly falls through to the next entry (that's what the
  /// login screen's `fontFamily: 'SF Mono'` has always done: it renders Menlo).
  /// The face is only reachable under its internal name, below. Verified with
  /// `NSFont(name:size:)` + `CTFontGetBoundingRectsForGlyphs`; a `flutter test`
  /// probe can't confirm this — the headless test font manager resolves every
  /// family to the same test face and reports monospace metrics for all of them.
  ///
  /// Menlo is the fallback, not a compromise: its glyphs measure within 0.01pt
  /// of SF Mono's at 13px. SF Mono leads only for a slashed zero and a tailed
  /// `l`, which is exactly what a model id needs. Avoid Monaco — it lacks a
  /// slashed zero.
  static String get mono => _codeFamily ?? monoDefault;

  /// The shipped code face, per platform — same argument as [sansDefault], and
  /// a worse failure when it is wrong: on Linux the whole Apple stack down to
  /// `Courier New` resolved to a PROPORTIONAL face, so anything set in "mono"
  /// was not monospaced at all. The Linux chain is the terminal's own default
  /// (see `lib/terminal/terminal_typography.dart` for why DejaVu leads).
  static String get monoDefault =>
      Platform.isMacOS ? _macMonoDefault : _linuxMonoDefault;

  static const String _macMonoDefault = '.AppleSystemUIFontMonospaced';
  static const String _linuxMonoDefault = 'DejaVu Sans Mono';

  /// The fallbacks behind [mono]. The system's own mono goes in front of them
  /// once a family is chosen, for the reason given on [sansFallback] — and it
  /// matters more here: a code block that falls through to a proportional face
  /// stops being a code block.
  static List<String> get monoFallback => _codeFamily == null
      ? _monoFallbackDefault
      : [monoDefault, ..._monoFallbackDefault];

  static List<String> get _monoFallbackDefault =>
      Platform.isMacOS ? _macMonoFallback : _linuxMonoFallback;

  static const List<String> _macMonoFallback = [
    'Menlo',
    'Monaco',
    'Courier New',
    'monospace',
  ];

  static const List<String> _linuxMonoFallback = [
    'Ubuntu Sans Mono',
    'Noto Sans Mono',
    'Liberation Mono',
    'monospace',
  ];

  /// Digits that hold a fixed width, so a stat doesn't reflow as its value
  /// changes and a column of numbers lines up.
  static const List<FontFeature> tabularFigures = [
    FontFeature.tabularFigures(),
  ];

  // — the weight ladder —
  //
  // Three steps, and the app should not need a fourth. Named rather than typed
  // as `FontWeight.w500` at the call site, because the numbers moved once
  // already: the app was drawn at w600 for every label and w700 for every
  // heading, which is a step heavier than macOS itself sets the same things.
  // Finder's sidebar, System Settings' rows and a push button's label are all
  // *medium*; semibold is what Apple reserves for a window title or a section
  // header that has to out-rank the rows under it.
  //
  // At 13pt on a Retina panel that one step is the difference between a UI that
  // reads as crisp and one that reads as shouted — every label competing with
  // every other, and nothing left to promote a heading with.

  /// Body copy, and anything that is simply being read.
  static const FontWeight regular = FontWeight.w400;

  /// The app's workhorse: control labels, sidebar items, row titles, table
  /// headers — anything that names something without being a heading.
  ///
  /// This is the weight that used to be [semibold] in 133 places.
  static const FontWeight medium = FontWeight.w500;

  /// Reserved for type that has to out-rank the medium text beside it: a screen
  /// or section heading, the selected row in a menu.
  ///
  /// If everything on a screen is semibold, nothing is — which is the state the
  /// ladder was introduced to fix. Reach for [medium] first.
  static const FontWeight semibold = FontWeight.w600;

  /// The tracking a given size wants, in logical pixels.
  ///
  /// SF Pro is an optically-sized family: on Apple's own platforms the system
  /// re-spaces it as it scales, opening the letters up at caption sizes and
  /// pulling them in at display sizes. Flutter asks CoreText for one static
  /// face, so none of that happens for free and every size came out at the
  /// metrics of whatever master got picked — which is why small text read as
  /// cramped and large headings read as one solid mass.
  ///
  /// The curve below follows Apple's own SF Pro tracking table, rounded to the
  /// steps this app actually uses:
  ///
  /// ```
  ///   ≥ 28pt   -0.4   display / greeting
  ///   ≥ 20pt   -0.25  screen titles
  ///   ≥ 17pt   -0.1   section headings
  ///   ≥ 15pt    0     body — the neutral point the app was drawn at
  ///   ≥ 13pt   +0.05  control labels
  ///   < 13pt   +0.12  captions, chips, meta
  /// ```
  ///
  /// The numbers are small on purpose. Tracking is not a style knob — at half a
  /// pixel it is already the difference between a line that breathes and one
  /// that doesn't, and anything larger starts to look like a logotype.
  static double trackingFor(double size) {
    if (size >= 28) return -0.4;
    if (size >= 20) return -0.25;
    if (size >= 17) return -0.1;
    if (size >= 15) return 0;
    if (size >= 13) return 0.05;
    return 0.12;
  }

  // — the user's type settings, mirrored here so a token read resolves them —
  //
  // These are set from one place (`FontSync` in `grid_app.dart`, fed by
  // `fontPrefsProvider`) and read from everywhere, exactly like
  // `AppTheme.brightness`. A widget reading them must call [AppTheme.watch] to
  // be rebuilt when they change — see that method for why a top-down rebuild
  // isn't enough in this app.

  static String? _uiFamily;
  static String? _codeFamily;
  static double _uiScale = 1;
  static double _codeSize = _codeSizeDefault;

  static const double _codeSizeDefault = 12.5;

  /// The UI size the app was DRAWN at, and therefore the denominator of
  /// [uiScale]: a setting of 14 gives a scale of exactly 1, which is the only
  /// value at which every control keeps the geometry this file specifies.
  ///
  /// Public because the settings screen has to divide by it to turn a size the
  /// user picked into the scale [apply] takes, and a second copy of the number
  /// on that side is a second thing to forget.
  static const double uiSizeDefault = 14;

  /// What every UI dimension is multiplied by: 1.0 is the size the app was
  /// drawn at.
  static double get uiScale => _uiScale;

  /// The size code is set at, in logical pixels.
  ///
  /// Absolute, not scaled: the UI scale reaches code through `MediaQuery`'s text
  /// scaler like it reaches everything else, so a code surface that also
  /// multiplied by [uiScale] would apply it twice. Code surfaces wrap themselves
  /// in `MediaQuery.withNoTextScaling` and use this number as-is.
  static double get codeSize => _codeSize;

  /// Apply the user's type settings. Returns true when something actually
  /// changed, so the caller only fires listeners on a real change.
  static bool apply({
    String? uiFamily,
    String? codeFamily,
    required double uiScale,
    required double codeSize,
  }) {
    if (uiFamily == _uiFamily &&
        codeFamily == _codeFamily &&
        uiScale == _uiScale &&
        codeSize == _codeSize) {
      return false;
    }
    _uiFamily = uiFamily;
    _codeFamily = codeFamily;
    _uiScale = uiScale;
    _codeSize = codeSize;
    return true;
  }

  /// The style for a surface made of code — a diff, a log, a code block, a
  /// model id the user is going to paste somewhere.
  ///
  /// Carries the user's code family *and* their code size, so a caller gets
  /// both from one place instead of remembering to read the second. [scale]
  /// is for the few call sites drawn deliberately smaller than body code (a
  /// caption under a block, a chip): it keeps them proportional to the user's
  /// choice rather than pinned to a number that stops matching once the setting
  /// moves.
  ///
  /// Pair this with `MediaQuery.withNoTextScaling` on the surface — see
  /// [codeSize] for why.
  static TextStyle codeStyle({
    Color? color,
    double scale = 1,
    double? height,
    FontWeight? fontWeight,
  }) => TextStyle(
    fontFamily: mono,
    fontFamilyFallback: monoFallback,
    fontSize: codeSize * scale,
    color: color,
    height: height,
    fontWeight: fontWeight,
  );

  /// Put the type settings back to the shipped defaults.
  ///
  /// For tests: the fields are static, so one test that changes the font would
  /// otherwise leak into every test that runs after it in the same process.
  static void reset() {
    _uiFamily = null;
    _codeFamily = null;
    _uiScale = 1;
    _codeSize = _codeSizeDefault;
  }
}

/// A text field's rim at one state. Radius matches [AppControl.radius] so a
/// field and the button next to it are cut from the same shape language.
OutlineInputBorder _fieldBorder(Color color, {double width = 1}) =>
    OutlineInputBorder(
      borderRadius: BorderRadius.circular(AppControl.radius),
      borderSide: BorderSide(color: color, width: width),
    );

/// The label style shared by every button, carrying the UI font: a
/// `ButtonStyle.textStyle` does **not** inherit `fontFamily` from the text
/// theme, so a button that sets only a size silently drops SF Pro.
///
/// A getter, not a const: it reads [AppFont.sans], which the user can change.
TextStyle get _buttonTextStyle => TextStyle(
  fontFamily: AppFont.sans,
  fontFamilyFallback: AppFont.sansFallback,
  fontSize: AppControl.fontSize,
  fontWeight: AppControl.fontWeight,
  // From the same ramp as the text theme, rather than a flat 0: a button's
  // label is 13pt, which is small enough to want its letters opened up.
  letterSpacing: AppFont.trackingFor(AppControl.fontSize),
);

/// A text field's own text: the macOS control font, so a field sits at the same
/// scale as the button next to it.
///
/// Material's default field text is `bodyLarge` — 16pt, sized for a phone. On a
/// desktop row that puts a visibly larger search box beside a 13pt button.
/// `InputDecorationTheme` has no `style` slot (it themes the *decoration*, not
/// the editable text), so a field must be handed this explicitly:
/// `TextField(style: kFieldTextStyle, ...)`.
TextStyle get kFieldTextStyle => _fieldTextStyle(AppPalette.textPrimary);

TextStyle _fieldTextStyle(Color color) => TextStyle(
  fontFamily: AppFont.sans,
  fontFamilyFallback: AppFont.sansFallback,
  fontSize: AppControl.fontSize,
  letterSpacing: AppFont.trackingFor(AppControl.fontSize),
  color: color,
);

/// A field's leading glyph — the magnifier on a search box, and its kind.
///
/// A step above [AppControl.iconSize], which is tuned to sit on the cap height
/// of a button's 13pt label. A field is [AppControl.heightField] tall, so the
/// button's glyph reads undersized in it — the icon has to follow the box it
/// sits in, not the token next to it. Themed via `prefixIconConstraints`, but
/// the `Icon` itself still has to be handed this size at the call site.
const double kFieldIconSize = 18;

RoundedRectangleBorder get _buttonShape => RoundedRectangleBorder(
  borderRadius: BorderRadius.circular(AppControl.radius),
);

/// The primary action: a solid accent capsule.
/// A filled button that destroys something.
///
/// Exists so the three that do — the two connector confirms and the skill delete
/// — cannot each pick their own red and their own label colour. Before this they
/// had three answers between them, and all three failed in dark: two set white
/// on [AppPalette.dangerFill]'s predecessor (3.42:1) and one left the label to
/// Material (3.83:1).
///
/// `foregroundColor` is named rather than left to `colorScheme.onError`, which
/// this app's scheme never sets — so Material fills in its own and lands under
/// the floor.
ButtonStyle dangerButtonStyle() => FilledButton.styleFrom(
  backgroundColor: AppPalette.dangerFill,
  foregroundColor: Colors.white,
);

ButtonStyle _filledButtonStyle() => FilledButton.styleFrom(
  minimumSize: Size(0, AppControl.heightScaled),
  padding: AppControl.paddingScaled,
  shape: _buttonShape,
  textStyle: _buttonTextStyle,
  // Material pads every button out to a 48px tap target — on a desktop app
  // that leaves a 32px button floating in a 48px box and wrecks every row it
  // sits in.
  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
  visualDensity: VisualDensity.standard,
  // Its own wash, not [AppSurface.hoverFill]: this button already carries the
  // accent as a FILL, so the hover has to read against that rather than against
  // the page. White at 12% lifts the accent a step without turning it into a
  // second colour. See [_textButtonStyle] for why any of these are needed at
  // all — `NoSplash` took the ripple away and left nothing behind it.
  overlayColor: const Color(0x1FFFFFFF),
);

/// The secondary action: a hairline rim, no fill — Apple's "bordered" button.
ButtonStyle _outlinedButtonStyle(ColorScheme scheme) =>
    OutlinedButton.styleFrom(
      minimumSize: Size(0, AppControl.heightScaled),
      padding: AppControl.paddingScaled,
      shape: _buttonShape,
      textStyle: _buttonTextStyle,
      side: BorderSide(color: scheme.outline),
      foregroundColor: scheme.onSurface,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      visualDensity: VisualDensity.standard,
    );

/// The tertiary action: text only, for the quiet way out of a dialog.
ButtonStyle _textButtonStyle() => TextButton.styleFrom(
  minimumSize: Size(0, AppControl.heightScaled),
  padding: AppControl.paddingSmallScaled,
  shape: _buttonShape,
  textStyle: _buttonTextStyle,
  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
  visualDensity: VisualDensity.standard,
  // ⚠️ Without this a text button has NO hover state at all.
  //
  // `splashFactory: NoSplash` turns Material's ripple off app-wide — right, it
  // is an Android idiom — but the ripple was also the only thing this theme
  // left drawing a response to the pointer. M3 derives its own overlay from
  // `foregroundColor`, and `styleFrom` here passes none, so the resolved
  // overlay came back **null**: the button lit up on press and on focus and did
  // nothing whatsoever on hover. On a desktop app, where the pointer is how you
  // find out what is clickable, that is a control that reads as a label.
  //
  // [AppSurface.hoverFill] is the same wash the rows and menu items already
  // use, so a button now answers the pointer the way everything around it does.
  overlayColor: AppSurface.hoverFill,
);

TextTheme _appTextTheme(Color primary, Color secondary) {
  final base = TextStyle(
    fontFamily: AppFont.sans,
    fontFamilyFallback: AppFont.sansFallback,
    color: primary,
    height: 1.34,
    fontWeight: AppFont.regular,
  );

  /// One step of the ramp, with its tracking derived from its size.
  TextStyle step(double size, {FontWeight? weight, Color? color}) =>
      base.copyWith(
        fontSize: size,
        fontWeight: weight,
        color: color,
        letterSpacing: AppFont.trackingFor(size),
      );

  // The ramp splits along one line: type that *is* a heading keeps semibold,
  // type that merely names a control drops to medium.
  //
  // Large sizes carry weight optically — 25pt at semibold is already emphatic,
  // and taking it to medium would leave a screen title reading as body copy that
  // happens to be big. Small sizes are the opposite: at 12–14pt semibold turns
  // into ink rather than emphasis, and it was on *every* label, so nothing was
  // emphasised relative to anything else.
  return TextTheme(
    displayLarge: step(57, weight: AppFont.semibold),
    displayMedium: step(45, weight: AppFont.semibold),
    displaySmall: step(36, weight: AppFont.semibold),
    headlineLarge: step(32, weight: AppFont.semibold),
    headlineMedium: step(29, weight: AppFont.semibold),
    headlineSmall: step(25, weight: AppFont.semibold),
    titleLarge: step(22, weight: AppFont.semibold),
    titleMedium: step(17, weight: AppFont.semibold),
    // 14.5 is where a "title" stops out-ranking anything and becomes a row
    // label, so this is the first step down.
    titleSmall: step(14.5, weight: AppFont.medium),
    bodyLarge: step(16.5),
    bodyMedium: step(15),
    bodySmall: step(13.5, color: secondary),
    // Every `label*` names a control. Medium, like the controls themselves.
    labelLarge: step(14.5, weight: AppFont.medium),
    labelMedium: step(13, weight: AppFont.medium),
    labelSmall: step(12, weight: AppFont.medium),
  );
}
