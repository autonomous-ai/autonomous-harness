/// What the Harness Store reads from the backend: how a harness is rated, and
/// what people wrote about it (`backend/src/routes/store.ts`).
///
/// The catalogue itself is NOT here. It is the registry the daemon answers
/// `dsh_list` with, per machine ([DshEntry]); the store lays ratings and
/// reviews over those rows. So a harness with no rating yet still has a page,
/// and a rating for a harness this build has never heard of is simply unused.
library;

class StoreRating {
  const StoreRating({
    required this.harnessId,
    required this.average,
    required this.count,
    required this.histogram,
  });

  /// `owner/name`.
  final String harnessId;

  /// Mean of the stars, two decimals; 0 when nobody has rated.
  final double average;
  final int count;

  /// How many gave one, two, three, four, five stars — index 0 is one star.
  final List<int> histogram;

  bool get isEmpty => count == 0;

  /// The empty rating for [harnessId]: what a page shows before anyone speaks.
  factory StoreRating.none(String harnessId) => StoreRating(
    harnessId: harnessId,
    average: 0,
    count: 0,
    histogram: const [0, 0, 0, 0, 0],
  );

  static StoreRating? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['harnessId'];
    final count = raw['count'];
    final average = raw['average'];
    final histogram = raw['histogram'];
    if (id is! String || id.isEmpty || count is! num) return null;
    final bars = histogram is List
        ? histogram.map((v) => v is num ? v.toInt().clamp(0, 1 << 30) : 0).toList()
        : <int>[];
    while (bars.length < 5) {
      bars.add(0);
    }
    return StoreRating(
      harnessId: id,
      average: (average is num ? average.toDouble() : 0.0).clamp(0.0, 5.0).toDouble(),
      count: count.toInt().clamp(0, 1 << 30),
      histogram: bars.take(5).toList(growable: false),
    );
  }
}

class StoreReview {
  const StoreReview({
    required this.id,
    required this.harnessId,
    required this.rating,
    required this.authorName,
    required this.mine,
    required this.updatedAt,
    this.title,
    this.body,
  });

  final String id;
  final String harnessId;

  /// 1..5.
  final int rating;
  final String? title;
  final String? body;

  /// The reviewer's name as the backend snapshotted it — never an email.
  final String authorName;

  /// Written by the signed-in person: the one review they can edit or delete.
  final bool mine;
  final DateTime updatedAt;

  static StoreReview? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final harnessId = raw['harnessId'];
    final rating = raw['rating'];
    final author = raw['authorName'];
    final updated = raw['updatedAt'];
    if (id is! String || harnessId is! String || rating is! num) return null;
    final stars = rating.toInt();
    if (stars < 1 || stars > 5) return null;
    final title = raw['title'];
    final body = raw['body'];
    return StoreReview(
      id: id,
      harnessId: harnessId,
      rating: stars,
      title: title is String && title.trim().isNotEmpty ? title.trim() : null,
      body: body is String && body.trim().isNotEmpty ? body.trim() : null,
      authorName: author is String && author.trim().isNotEmpty
          ? author.trim()
          : 'Harness user',
      mine: raw['mine'] == true,
      updatedAt:
          (updated is String ? DateTime.tryParse(updated) : null) ??
          DateTime.fromMillisecondsSinceEpoch(0),
    );
  }
}

/// One harness's page worth of reviews: the summary, everyone's words, and
/// the signed-in person's own (also in the list, first).
class StoreReviews {
  const StoreReviews({
    required this.rating,
    required this.reviews,
    required this.mine,
  });

  final StoreRating rating;
  final List<StoreReview> reviews;
  final StoreReview? mine;
}
