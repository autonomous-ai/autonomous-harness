/// Local UI boundary for controls that operate on the rendered terminal but
/// do not travel to the remote tmux pane.
enum TerminalFindAction { open, next, previous }

abstract interface class TerminalViewport {
  /// One report from the hardware dial.
  ///
  /// [phase] is 0 (down), 1 (move), or 2 (up). [dy] is the movement in glass
  /// pixels and [velocity] is glass pixels per second at release.
  void scroll(int phase, int dy, int velocity);

  /// Opens or steps through local terminal output without sending a key.
  void find(TerminalFindAction action);

  /// Claims an already mounted editor before navigation's next rendered frame.
  /// False means the destination has no ready input view yet.
  bool focusInput();

  /// Empties the software keyboard's own copy of what was typed, after the
  /// prompt has been cleared on the far side. Left holding the old words, the
  /// keyboard would edit them again — Vietnamese Telex re-marks the word it
  /// thinks is being typed, and would rub out characters already gone.
  void clearInputBuffer();
}
