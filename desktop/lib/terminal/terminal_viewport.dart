/// Local UI boundary for controls that operate on the rendered terminal but
/// do not travel to the remote tmux pane.
abstract interface class TerminalViewport {
  /// One report from the hardware dial.
  ///
  /// [phase] is 0 (down), 1 (move), or 2 (up). [dy] is the movement in glass
  /// pixels and [velocity] is glass pixels per second at release.
  void scroll(int phase, int dy, int velocity);
}
