import 'package:harness_mobile/core/fuzzy_match.dart';

import 'phone_search_index.dart';

/// The query, split into the words that each have to match something.
///
/// Every word must hit — possibly a DIFFERENT field each — so "review mac" finds
/// the review agent on the MacBook without either word having to match the whole
/// row. The desktop splits the same way, and the freedom to match different
/// fields is what makes word order not matter.
List<String> phoneSearchTerms(String query) => query
    .toLowerCase()
    .split(RegExp(r'\s+'))
    .where((term) => term.isNotEmpty)
    .toList();

/// How well [term] matches [field]: LOWER is better, null does not match.
///
/// Ported from the desktop's `swarmFieldMatchScore` so both apps rank alike.
/// The bands, cheapest first: an exact field, a prefix, a substring anywhere,
/// and last a scattered-letter subsequence whose cost grows with how far apart
/// the letters landed. A non-title field takes a flat 64 penalty, which is what
/// keeps a name match ahead of every piece of metadata under it.
int? phoneFieldMatchScore(String field, String term, {required bool title}) {
  final offset = field.indexOf(term);
  final spread = offset >= 0 ? 0 : subsequenceSpread(field, term);
  if (spread == null) return null;
  return (title ? 0 : 64) +
      (field == term
          ? 0
          : offset == 0
          ? 8
          : offset > 0
          ? 16
          : 128 + spread);
}

/// The field [term] reaches best on [row] — its score and its index in
/// [PhoneSearchResult.fields] — or null when it reaches none.
///
/// Shared by the ranking and by the emphasis, so the field a row is ranked on is
/// the field that is bolded.
///
/// Bounded: a pathologically long field is skipped rather than scanned, so one
/// agent named with a pasted log cannot make a keystroke cost more than a frame.
({int score, int index})? phoneBestFieldMatch(
  PhoneSearchResult row,
  String term,
) {
  ({int score, int index})? best;
  for (final (index, field) in row.fields.indexed) {
    if (field.length > 4096) continue;
    final score = phoneFieldMatchScore(
      field,
      term,
      title: index < row.titleFields,
    );
    if (score != null && (best == null || score < best.score)) {
      best = (score: score, index: index);
    }
    // Every field past the title fields is metadata, whose best possible score
    // is 64. An exact, prefix or substring title match already beats that, so
    // once the title fields are behind us there is nothing left to find.
    if (best != null && index >= row.titleFields - 1 && best.score <= 64) {
      break;
    }
  }
  return best;
}

/// Whether [term] appears, as written, in what was last said to [row]'s agent.
///
/// Literal only — never the scattered-letter match the fields get. Three turns of
/// prose contain almost every short run of letters somewhere, so a fuzzy hit in
/// them would return every agent on the account.
bool phoneRecallHas(PhoneSearchResult row, String term) =>
    row.recall?.searchText.contains(term) ?? false;

/// What a word found only in the conversation costs: more than any metadata
/// match can, so an agent that IS "llama" stays ahead of one that talked about it.
const _recallScore = 256;

/// The rows [query] reaches, best first.
///
/// An empty query keeps index order untouched: [phoneSearchIndex] already put
/// the agents in the order worth offering before a word is typed.
///
/// A word that matches no field is looked for in the agent's recall — what was
/// last asked of it and what it answered — which is how "llama" finds the agent
/// somebody asked about llama.cpp. Rows that needed the conversation to match
/// rank after every row that matched on the agent itself, as on the desktop.
///
/// ⚠️ Ties break on the row's position in the index, never on anything that
/// moves by itself. An agent that starts working sorts upward in [agentIndex],
/// and that is the one reshuffle worth having; a second, unstable tiebreak on
/// top of it would let two idle rows swap places on an unrelated rebuild.
List<PhoneSearchResult> rankPhoneSearch(
  List<PhoneSearchResult> all,
  String query,
) {
  final needle = query.trim().toLowerCase();
  if (needle.isEmpty) return all;
  final terms = phoneSearchTerms(needle);
  if (terms.isEmpty) return all;

  final ranked =
      <({PhoneSearchResult row, int score, bool recalled, int index})>[];
  for (final (index, row) in all.indexed) {
    // An exact hit on the name — or the title — wins outright, ahead of every
    // scored row. Typing one in full is the least ambiguous thing somebody can do.
    if (row.fields.take(row.titleFields).contains(needle)) {
      ranked.add((row: row, score: -1, recalled: false, index: index));
      continue;
    }
    final match = _scoreRow(row, terms);
    if (match == null) continue;
    ranked.add((
      row: row,
      score: match.score,
      recalled: match.recalled,
      index: index,
    ));
  }

  int byRecall(bool recalled) => recalled ? 1 : 0;
  ranked.sort((a, b) {
    var order = byRecall(a.recalled).compareTo(byRecall(b.recalled));
    if (order == 0) order = a.score.compareTo(b.score);
    return order != 0 ? order : a.index.compareTo(b.index);
  });
  return [for (final row in ranked) row.row];
}

/// Every term's best score on [row] summed, and whether any needed the recall —
/// or null when one term matches nothing at all.
///
/// One word matching nothing drops the row: the words narrow, they do not
/// accumulate. Without this, "review mac" would return everything either word
/// touches.
({int score, bool recalled})? _scoreRow(
  PhoneSearchResult row,
  List<String> terms,
) {
  var total = 0;
  var recalled = false;
  for (final term in terms) {
    final best = phoneBestFieldMatch(row, term);
    if (best != null) {
      total += best.score;
      continue;
    }
    if (!phoneRecallHas(row, term)) return null;
    recalled = true;
    total += _recallScore;
  }
  return (score: total, recalled: recalled);
}

/// The part of [row]'s recall worth quoting under its name: the line holding the
/// first word that no field matched, from a little before that word.
///
/// Null when every word matched the agent itself — the row's own subtitle then
/// says why it is there, and a quote would only be noise.
String? phoneRecallSnippet(PhoneSearchResult row, List<String> terms) {
  final recall = row.recall;
  if (recall == null) return null;
  for (final term in terms) {
    if (phoneBestFieldMatch(row, term) != null) continue;
    for (final line in recall.lines) {
      final at = line.toLowerCase().indexOf(term);
      if (at >= 0) return _quote(line, at);
    }
  }
  return null;
}

/// How much of the line before the matched word stays in the quote.
const _lead = 16;

/// [line] from a little before [at], so the word lands near the row's start
/// rather than past the ellipsis on a phone's width.
String _quote(String line, int at) {
  // Lowercasing can change a string's length; an index into the folded line is
  // only trusted on the original when the two are the same length.
  final folds = line.toLowerCase().length == line.length;
  var start = folds && at > _lead ? at - _lead : 0;
  // Never start inside a surrogate pair — the quote would open on half an emoji.
  if (start > 0 && _isLowSurrogate(line.codeUnitAt(start))) start--;
  return start == 0 ? line : '…${line.substring(start).trimLeft()}';
}

bool _isLowSurrogate(int unit) => unit >= 0xDC00 && unit <= 0xDFFF;
