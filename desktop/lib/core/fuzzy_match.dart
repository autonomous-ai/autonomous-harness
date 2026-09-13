/// The spread of a subsequence match, or null when the query does not match.
/// Both arguments should already be normalized for case.
int? subsequenceSpread(String text, String query) {
  if (query.isEmpty) return 0;
  var at = -1;
  var first = -1;
  for (final rune in query.runes) {
    final found = text.indexOf(String.fromCharCode(rune), at + 1);
    if (found < 0) return null;
    if (first < 0) first = found;
    at = found;
  }
  return at - first;
}
