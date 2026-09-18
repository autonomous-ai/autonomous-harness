import 'package:flutter/widgets.dart';

import 'package:harness_mobile/core/fuzzy_match.dart';

import 'phone_search_index.dart';
import 'phone_search_rank.dart';

/// Which field earned each query term its score, and whether that field is the
/// row's title.
typedef PhoneFieldMatch = ({String field, String term, bool title});

/// [terms] as matches on a recall quote (see [phoneRecallSnippet]): each term is
/// its own field, so the emphasis lands on the word wherever the quote holds it.
List<PhoneFieldMatch> phoneRecallMatches(List<String> terms) => [
  for (final term in terms.take(12).toSet())
    (field: term, term: term, title: false),
];

/// The field each term actually matched, so only that one is emphasised.
///
/// Recomputed per visible row rather than carried through ranking: the work is
/// bounded by what is on screen, and keeping it out of the ranking path means
/// scrolling never pays for emphasis it has already drawn.
List<PhoneFieldMatch> phoneResultMatches(
  PhoneSearchResult row,
  List<String> terms,
) {
  final matches = <PhoneFieldMatch>[];
  // Bounded: a pathological query must not turn one row's emphasis into more
  // work than drawing the whole list.
  for (final term in terms.take(12).toSet()) {
    if (term.length > 128) continue;
    final best = phoneBestFieldMatch(row, term);
    if (best == null) continue;
    matches.add((
      field: row.fields[best.index],
      term: term,
      title: best.index < row.titleFields,
    ));
  }
  return matches;
}

/// A stretch of text, and whether the query reached it.
typedef PhoneTextRun = ({String text, bool matched});

/// [text] split into matched and unmatched runs.
///
/// Walks GRAPHEME clusters, not code units, because case folding can change a
/// string's length and a query can land in the middle of an emoji or a combining
/// sequence — an agent named "🇻🇳 deploy" must not be cut through its flag.
/// Long labels are left plain: emphasis is worth a bounded amount of layout work
/// on a one-line row and no more.
List<PhoneTextRun> phoneTextRuns(
  String text,
  Iterable<PhoneFieldMatch> matches,
) {
  if (matches.isEmpty || text.isEmpty || text.length > 1024) {
    return [(text: text, matched: false)];
  }
  final clusters = <({int start, int end, int foldedStart, int foldedEnd})>[];
  final folded = StringBuffer();
  var offset = 0;
  var foldedOffset = 0;
  for (final cluster in text.characters) {
    final lower = cluster.toLowerCase();
    clusters.add((
      start: offset,
      end: offset + cluster.length,
      foldedStart: foldedOffset,
      foldedEnd: foldedOffset + lower.length,
    ));
    offset += cluster.length;
    foldedOffset += lower.length;
    folded.write(lower);
  }
  final normalized = folded.toString();

  final positions = <({int start, int end})>[];
  for (final match in matches) {
    // A row can match on a field it never draws — an engine id, a project path.
    // Emphasising something in unrelated text because of it would be a lie about
    // why the row is there.
    final fieldAt = normalized.indexOf(match.field);
    if (fieldAt < 0) continue;
    final exact = match.field.indexOf(match.term);
    if (exact >= 0) {
      positions.add((
        start: fieldAt + exact,
        end: fieldAt + exact + match.term.length,
      ));
      continue;
    }
    final fuzzy = <({int start, int end})>[];
    final spread = subsequenceSpread(
      match.field,
      match.term,
      onMatch: (start, end) =>
          fuzzy.add((start: fieldAt + start, end: fieldAt + end)),
    );
    if (spread != null) positions.addAll(fuzzy);
  }
  if (positions.isEmpty) return [(text: text, matched: false)];
  positions.sort((a, b) => a.start.compareTo(b.start));

  final runs = <PhoneTextRun>[];
  var start = 0;
  var positionIndex = 0;
  bool? active;
  for (final cluster in clusters) {
    while (positionIndex < positions.length &&
        positions[positionIndex].end <= cluster.foldedStart) {
      positionIndex++;
    }
    final matched =
        positionIndex < positions.length &&
        positions[positionIndex].start < cluster.foldedEnd;
    if (active != null && active != matched) {
      runs.add((text: text.substring(start, cluster.start), matched: active));
      start = cluster.start;
    }
    active = matched;
  }
  runs.add((text: text.substring(start), matched: active ?? false));
  return runs;
}

/// One line of a search result, with the part the query reached set in bold.
///
/// Weight alone carries the emphasis — no colour, no highlight fill. A result
/// list is already dense with tone (a status dot, an attention rim), and a
/// second colour meaning "you typed this" would compete with the one meaning
/// "this needs you".
class SearchResultText extends StatelessWidget {
  const SearchResultText(
    this.text, {
    super.key,
    required this.matches,
    required this.style,
  });

  final String text;
  final Iterable<PhoneFieldMatch> matches;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    final runs = phoneTextRuns(text, matches);
    if (!runs.any((run) => run.matched)) {
      return Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: style,
      );
    }
    return Text.rich(
      TextSpan(
        children: [
          for (final run in runs)
            TextSpan(
              text: run.text,
              style: run.matched
                  ? const TextStyle(fontWeight: FontWeight.w700)
                  : null,
            ),
        ],
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: style,
    );
  }
}
