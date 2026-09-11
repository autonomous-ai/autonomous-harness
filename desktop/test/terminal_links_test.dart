import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_links.dart';
import 'package:xterm/xterm.dart';

void main() {
  final cases = <(String, String, String)>[
    ('Saved /tmp/preview.png.', 'preview', '/tmp/preview.png'),
    (
      'Video: /tmp/My clips/demo (final).MP4',
      'final',
      '/tmp/My clips/demo (final).MP4',
    ),
    ('`/tmp/My art/ảnh 🖼️.png`', 'My art', '/tmp/My art/ảnh 🖼️.png'),
    ('"~/Pictures/My image.heic"', 'image', '~/Pictures/My image.heic'),
    (
      '[Watch video](</tmp/My clips/clip.mov>)',
      'Watch',
      '/tmp/My clips/clip.mov',
    ),
    ('![Image](/tmp/preview.webp)', 'Image', '/tmp/preview.webp'),
    (
      'Open file:///tmp/My%20art/preview.png',
      'preview',
      'file:///tmp/My%20art/preview.png',
    ),
    (
      'See https://example.com/a.mp4?token=a%2Fb&v=2.',
      'a.mp4',
      'https://example.com/a.mp4?token=a%2Fb&v=2',
    ),
    (
      '(https://example.com/a_(v2).mp4).',
      'v2',
      'https://example.com/a_(v2).mp4',
    ),
    ('/tmp/one.png and /tmp/two.mp4', 'two', '/tmp/two.mp4'),
    ('output/preview.gif', 'preview', 'output/preview.gif'),
    (
      r'C:\Users\Me\My art\preview.png',
      'preview',
      r'C:\Users\Me\My art\preview.png',
    ),
  ];
  for (final (text, needle, target) in cases) {
    test('recognizes $text', () {
      expect(terminalLinkInText(text, text.indexOf(needle)), target);
    });
  }
  for (final text in [
    'ordinary text',
    '/tmp/run.sh',
    'javascript:alert(1)',
    'data:image/png;base64,a',
    '[Image](command:run.png)',
  ]) {
    test('does not turn $text into an OS action', () {
      expect(terminalLinkInText(text, 0), isNull);
    });
  }
  test('does not open adjacent whitespace or punctuation', () {
    const text = 'Image: /tmp/preview.png.';
    expect(terminalLinkInText(text, 6), isNull);
    expect(terminalLinkInText(text, text.length - 1), isNull);
  });
  test('maps wide characters and emoji to the clicked terminal cells', () {
    final terminal = Terminal()..resize(100, 4);
    terminal.write('图 😀 /tmp/ảnh.png');
    expect(terminalLinkAt(terminal, const CellOffset(10, 0)), '/tmp/ảnh.png');
    expect(terminalLinkAt(terminal, const CellOffset(1, 0)), isNull);
    terminal.write('\r\n/tmp/图.png');
    // Both cells of the CJK character point to the same file.
    expect(terminalLinkAt(terminal, const CellOffset(5, 1)), '/tmp/图.png');
    expect(terminalLinkAt(terminal, const CellOffset(6, 1)), '/tmp/图.png');
  });
  test('finds the entire path across terminal soft wraps', () {
    final terminal = Terminal()..resize(20, 6);
    const path = '/tmp/a-very-long-folder/preview.mp4';
    terminal.write(path);
    expect(terminalLinkAt(terminal, const CellOffset(3, 1)), path);
  });
  test('never joins separate output lines or stale streamed content', () {
    final terminal = Terminal()..resize(80, 4);
    terminal.write('/tmp/preview.');
    expect(terminalLinkAt(terminal, const CellOffset(6, 0)), isNull);
    terminal.write('png');
    expect(
      terminalLinkAt(terminal, const CellOffset(6, 0)),
      '/tmp/preview.png',
    );
    terminal.write('\r\x1b[2KWorking...');
    expect(terminalLinkAt(terminal, const CellOffset(6, 0)), isNull);
    terminal.write('\r\n/tmp/next.\r\nmp4');
    expect(terminalLinkAt(terminal, const CellOffset(6, 1)), isNull);
  });
  test('handles scrollback and bounds extremely long output', () {
    final terminal = Terminal(maxLines: 100)..resize(20, 3);
    terminal.write('/tmp/preview.png\r\nnext\r\nnext\r\nnext');
    expect(
      terminalLinkAt(terminal, const CellOffset(6, 0)),
      '/tmp/preview.png',
    );
    terminal.write('\r\n/${'x' * 1000}.png');
    expect(
      terminalLinkAt(terminal, CellOffset(2, terminal.buffer.lines.length - 1)),
      isNull,
    );
  });
}
