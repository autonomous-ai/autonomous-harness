enum TerminalMouseButton {
  left(id: 0),

  middle(id: 1),

  right(id: 2),

  wheelUp(id: 64, isWheel: true),

  wheelDown(id: 65, isWheel: true),

  wheelLeft(id: 66, isWheel: true),

  wheelRight(id: 67, isWheel: true),
  ;

  /// The id that is used to report a button press or release to the terminal.
  ///
  /// Per the xterm mouse-tracking spec, wheel events reuse the button-1/button-2 event codes
  /// (0 and 1) with 64 added — i.e. wheel-up=64, wheel-down=65 (and, by the same extension used for
  /// horizontal wheel/tilt, wheel-left=66, wheel-right=67). These are NOT "id 4"/"id 5" (the
  /// conventional 1-based wheel button numbers) plus 64 — that produced 68/69/70/71, codes outside
  /// what any real terminal program's mouse-report parser recognizes as a wheel event, so a program
  /// that owns its own mouse-tracking (e.g. the Claude Code CLI) silently ignored every wheel report
  /// this emitted. Confirmed against a real program: identical bytes with Cb=64/65 scroll it
  /// correctly; Cb=68/69 do nothing.
  final int id;

  /// Whether this button is a mouse wheel button.
  final bool isWheel;

  const TerminalMouseButton({required this.id, this.isWheel = false});
}
