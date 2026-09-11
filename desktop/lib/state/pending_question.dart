/// One agent stopped mid-turn to ask the person something.
///
/// The daemon finds these by reading the pane while a turn is open — the
/// transcript is useless for it, because the engine does not flush the
/// `AskUserQuestion` line until the question has already been ANSWERED. So a
/// question exists here for exactly as long as its dialog is on screen, and the
/// daemon says so twice: `commander_question` when it appears,
/// `commander_question_close` when it stops being on screen for any reason —
/// including someone answering it on a different client.
///
/// That second frame is the whole reason this is state and not a widget flag.
/// A question can be answered from the pane, from another window, or from the
/// dial cabled to this computer, and every one of those arrives back here down
/// the same path — so the ring cannot outlive a dialog somebody else closed.
///
/// The tile's amber ring is the only thing that reads this.
class PendingQuestion {
  PendingQuestion({
    required this.machineId,
    required this.agentId,
    required this.requestId,
    required this.answerKey,
    required this.prompt,
    required this.options,
    required this.multi,
    required this.since,
  });

  final String machineId;
  final String agentId;

  /// Opaque id from the daemon — a hash of the session and the question's own
  /// text, so re-announcing the same open question is idempotent.
  final String requestId;

  /// What the `answers` map must be keyed by when replying. The daemon sets it
  /// to the question text itself for a pane-derived question; keeping it
  /// separate from [prompt] means a future engine can key by an id instead
  /// without every call site guessing.
  final String answerKey;

  final String prompt;
  final List<String> options;

  /// Whether the dialog takes more than one option. Parsed because the frame
  /// carries it; nothing acts on it while the ring is the only surface.
  final bool multi;

  /// When this window first heard about it. Not when the agent actually
  /// blocked: a question that was already on screen when the app started is
  /// re-announced on attach, so the age shown is "how long we have known",
  /// which is the honest claim.
  final DateTime since;

  /// Same question, same agent — used to keep [since] across the re-announce
  /// that follows a reconnect, so reattaching does not reset every clock.
  bool sameAs(PendingQuestion other) =>
      other.requestId == requestId && other.agentId == agentId;

  PendingQuestion withSince(DateTime value) => PendingQuestion(
    machineId: machineId,
    agentId: agentId,
    requestId: requestId,
    answerKey: answerKey,
    prompt: prompt,
    options: options,
    multi: multi,
    since: value,
  );

  /// Build from a `commander_question` payload, or null if it carries nothing
  /// answerable. The daemon sends `questions` as a list but a pane-derived
  /// dialog is always exactly one — take the first and ignore the rest rather
  /// than inventing a queue no engine currently produces.
  static PendingQuestion? fromPayload({
    required String machineId,
    required String agentId,
    required Map<String, dynamic> payload,
    required DateTime now,
  }) {
    final requestId = payload['requestId'];
    if (requestId is! String || requestId.isEmpty) return null;
    final questions = payload['questions'];
    if (questions is! List || questions.isEmpty) return null;
    final first = questions.first;
    if (first is! Map) return null;

    final prompt = (first['q'] ?? first['key'] ?? '').toString().trim();
    if (prompt.isEmpty) return null;
    final rawOptions = first['options'];
    final options = rawOptions is List
        ? rawOptions
              .map((option) => option.toString().trim())
              .where((option) => option.isNotEmpty)
              .toList(growable: false)
        : const <String>[];

    return PendingQuestion(
      machineId: machineId,
      agentId: agentId,
      requestId: requestId,
      answerKey: (first['key'] ?? prompt).toString(),
      prompt: prompt,
      options: options,
      multi: first['multi'] == true,
      since: now,
    );
  }
}
