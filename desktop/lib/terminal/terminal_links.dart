import 'package:xterm/xterm.dart';

const _mediaExtensions =
    r'png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?|svg|ico|'
    r'mp4|m4v|mov|webm|mkv|avi|mpe?g|ogv|3gp';
final _mediaSuffix = RegExp('\\.(?:$_mediaExtensions)\$', caseSensitive: false);
final _markdownLink = RegExp(
  r'!?\[[^\]\r\n]*\]\((<[^>\r\n]+>|(?:[^()\r\n]|\([^()\r\n]*\))+)\)',
);
final _quotedTarget = RegExp(
  r'''`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|<([^<>\r\n]+)>''',
);
final _webTarget = RegExp(r'''https?://[^\s<>`"']+''', caseSensitive: false);
final _absoluteMedia = RegExp(
  r'''(?:^|[\s(\[<='"`])((?:file://|~/|/(?!/)|[a-z]:[\\/]|\.{1,2}/)[^<>\r\n`"|]*?\.(?:''' +
      _mediaExtensions +
      r'''))(?=$|[\s)\]}>.,;:!?])''',
  caseSensitive: false,
);
final _relativeMedia = RegExp(
  r'''[^\s<>`"'()\[\]]+\.(?:''' +
      _mediaExtensions +
      r''')(?=$|[\s)\]}>.,;:!?])''',
  caseSensitive: false,
);

bool isMediaPath(String path) => _mediaSuffix.hasMatch(path);

bool _isTarget(String target) {
  final uri = Uri.tryParse(target);
  if (uri == null) return false;
  if (uri.scheme == 'http' || uri.scheme == 'https') {
    return uri.host.isNotEmpty;
  }
  if (uri.scheme == 'file') return isMediaPath(uri.path);
  // A drive letter is a file path, not a custom URI scheme.
  if (uri.hasScheme &&
      !RegExp(r'^[a-z]:[\\/]', caseSensitive: false).hasMatch(target)) {
    return false;
  }
  return isMediaPath(target);
}

String _trimWebPunctuation(String target) {
  var result = target.replaceFirst(RegExp(r'[.,;:!?]+$'), '');
  for (final pair in [('(', ')'), ('[', ']')]) {
    while (result.endsWith(pair.$2) &&
        pair.$2.allMatches(result).length > pair.$1.allMatches(result).length) {
      result = result.substring(0, result.length - 1);
    }
  }
  return result;
}

/// Finds only the target under the pointer. No file IO or scan of scrollback.
/// Markdown labels and quoted paths retain spaces; bare URLs retain queries.
String? terminalLinkInText(String text, int offset) {
  if (offset < 0 || offset >= text.length) return null;
  for (final match in _markdownLink.allMatches(text)) {
    if (offset < match.start || offset >= match.end) continue;
    var target = match[1]!;
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.substring(1, target.length - 1);
    }
    return _isTarget(target) ? target : null;
  }
  for (final match in _quotedTarget.allMatches(text)) {
    if (offset < match.start || offset >= match.end) continue;
    final target = [
      match[1],
      match[2],
      match[3],
      match[4],
    ].whereType<String>().single;
    if (_isTarget(target)) return target;
  }
  for (final match in _webTarget.allMatches(text)) {
    if (offset < match.start || offset >= match.end) continue;
    final target = _trimWebPunctuation(match[0]!);
    return offset < match.start + target.length && _isTarget(target)
        ? target
        : null;
  }
  for (final pattern in [_absoluteMedia, _relativeMedia]) {
    for (final match in pattern.allMatches(text)) {
      final target = match.groupCount == 0 ? match[0]! : match[1]!;
      final start = match.end - target.length;
      if (offset >= start && offset < match.end && _isTarget(target)) {
        return target;
      }
    }
  }
  return null;
}

/// Reconstructs the clicked logical line across terminal soft wraps, mapping
/// cell columns to UTF-16 offsets (wide CJK and emoji are not one code unit).
/// The bound also keeps malformed/unbroken output cheap during mouse hover.
String? terminalLinkAt(Terminal terminal, CellOffset cell) {
  final lines = terminal.buffer.lines;
  if (cell.y < 0 ||
      cell.y >= lines.length ||
      cell.x < 0 ||
      cell.x >= lines[cell.y].length) {
    return null;
  }
  var start = cell.y;
  var end = cell.y;
  while (start > 0 && lines[start].isWrapped) {
    if (cell.y - start >= 16) return null;
    start--;
  }
  while (end + 1 < lines.length && lines[end + 1].isWrapped) {
    if (end - start >= 16) return null;
    end++;
  }
  final text = StringBuffer();
  int? offset;
  for (var y = start; y <= end; y++) {
    final line = lines[y];
    var previousOffset = text.length;
    for (var x = 0; x < line.length; x++) {
      final continuation = x > 0 && line.getWidth(x - 1) == 2;
      if (cell.y == y && cell.x == x) {
        offset = continuation ? previousOffset : text.length;
      }
      if (continuation) continue;
      previousOffset = text.length;
      final codePoint = line.getCodePoint(x);
      text.writeCharCode(codePoint == 0 ? 0x20 : codePoint);
      if (text.length > 8192) return null;
    }
  }
  return offset == null ? null : terminalLinkInText(text.toString(), offset);
}
