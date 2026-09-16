import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../core/dsh_catalog.dart';
import 'store_models.dart';

/// The store's calls, behind an interface so a widget test can answer them
/// without a backend — the same seam `CliLogin` and the usage sources have.
abstract class StoreApi {
  Future<List<StoreRating>> ratings();
  Future<StoreReviews> reviews(String harnessId);
  Future<StoreReview> putReview(
    String harnessId, {
    required int rating,
    String? title,
    String? body,
  });
  Future<void> deleteReview(String harnessId);
}

/// The real one: the control plane, through the local CLI.
class ApiStoreApi implements StoreApi {
  ApiStoreApi(this.api);

  final ApiClient api;

  @override
  Future<List<StoreRating>> ratings() async {
    final data = await api.storeRatings();
    final raw = data?['ratings'];
    if (raw is! List) return const [];
    return raw.map(StoreRating.fromJson).whereType<StoreRating>().toList();
  }

  @override
  Future<StoreReviews> reviews(String harnessId) async {
    final data = await api.storeReviews(harnessId);
    final raw = data?['reviews'];
    final reviews = raw is List
        ? raw.map(StoreReview.fromJson).whereType<StoreReview>().toList()
        : <StoreReview>[];
    return StoreReviews(
      rating: StoreRating.fromJson(data?['rating']) ?? StoreRating.none(harnessId),
      reviews: reviews,
      mine: StoreReview.fromJson(data?['mine']),
    );
  }

  @override
  Future<StoreReview> putReview(
    String harnessId, {
    required int rating,
    String? title,
    String? body,
  }) async {
    final data = await api.putStoreReview(
      harnessId,
      rating: rating,
      title: title,
      body: body,
    );
    final review = StoreReview.fromJson(data?['review']);
    if (review == null) throw const FormatException('store: no review in answer');
    return review;
  }

  @override
  Future<void> deleteReview(String harnessId) => api.deleteStoreReview(harnessId);
}

/// What the store screen holds while open: every harness's rating, and the
/// reviews of the pages visited. Owned by the screen, gone with it — a rating
/// is worth re-reading on the next visit, not caching across the app.
class StoreController extends ChangeNotifier {
  StoreController(this.api);

  final StoreApi api;

  final Map<String, StoreRating> ratings = {};
  bool ratingsLoading = false;
  bool ratingsLoaded = false;

  /// The last failure, as a sentence; null when the backend answered.
  String? ratingsError;

  final Map<String, StoreReviews> reviews = {};
  final Set<String> reviewsLoading = {};
  final Map<String, String> reviewsError = {};

  StoreRating ratingOf(String harnessId) =>
      ratings[harnessId] ?? StoreRating.none(harnessId);

  /// What a row is rated under. A harness by its registry id; an engine —
  /// never in the registry — under `engine/<id>`, the two-part shape the
  /// backend keys on.
  static String keyFor(DshEntry entry) =>
      entry.isEngine ? 'engine/${entry.id}' : entry.id;

  Future<void> loadRatings() async {
    if (ratingsLoading) return;
    ratingsLoading = true;
    notifyListeners();
    try {
      final list = await api.ratings();
      ratings
        ..clear()
        ..addEntries(list.map((r) => MapEntry(r.harnessId, r)));
      ratingsError = null;
    } catch (error) {
      ratingsError = _sentence(error, 'Ratings are not available right now');
    } finally {
      ratingsLoading = false;
      ratingsLoaded = true;
      notifyListeners();
    }
  }

  Future<void> loadReviews(String harnessId) async {
    if (reviewsLoading.contains(harnessId)) return;
    reviewsLoading.add(harnessId);
    notifyListeners();
    try {
      final page = await api.reviews(harnessId);
      reviews[harnessId] = page;
      ratings[harnessId] = page.rating;
      reviewsError.remove(harnessId);
    } catch (error) {
      reviewsError[harnessId] = _sentence(error, 'Reviews are not available right now');
    } finally {
      reviewsLoading.remove(harnessId);
      notifyListeners();
    }
  }

  /// Write the signed-in person's review. Null on success, else a sentence.
  Future<String?> submit(
    String harnessId, {
    required int rating,
    String? title,
    String? body,
  }) async {
    try {
      await api.putReview(harnessId, rating: rating, title: title, body: body);
    } catch (error) {
      return _sentence(error, 'Your review could not be posted');
    }
    await loadReviews(harnessId);
    return null;
  }

  /// Delete the signed-in person's review. Null on success, else a sentence.
  Future<String?> remove(String harnessId) async {
    try {
      await api.deleteReview(harnessId);
    } catch (error) {
      return _sentence(error, 'Your review could not be removed');
    }
    await loadReviews(harnessId);
    return null;
  }

  /// A failure as the page should say it. A 404 is the one case worth its own
  /// words: it is a control plane that predates the store, not a bad request,
  /// and the store is still whole without it.
  static String _sentence(Object error, String fallback) {
    if (error is ApiException) {
      return switch (error.status) {
        404 => 'Ratings and reviews are not on the Harness server yet; they arrive with its next release.',
        401 || 403 => 'Sign in to see ratings and reviews.',
        _ => error.message.trim().isEmpty ? fallback : error.message.trim(),
      };
    }
    return fallback;
  }
}
