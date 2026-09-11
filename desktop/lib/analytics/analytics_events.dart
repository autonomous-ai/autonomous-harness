import 'analytics.dart';

/// The events this app sends, one method each.
///
/// An extension rather than a set of loose helpers, so every [Analytics]
/// implementation gets them for free — and so the name and the params of an
/// event are written down **once**. Two call sites that name the same action
/// differently is the failure mode this exists to prevent.
///
/// Adding an event: add a method here, keep the name `snake_case`, and keep the
/// params to product facts — a short code, an option, a count. **Never** a
/// prompt, terminal output, an agent's name, a repository path or a machine
/// hostname. This stream describes what someone did, not what they wrote or
/// what their machines are called; ids are fine, the names people give things
/// are not.
extension AnalyticsEvents on Analytics {
  // --- The launch ---------------------------------------------------------

  /// The app came up. [signedIn] separates a returning user from someone who
  /// is about to meet the login screen.
  void appOpened({required bool signedIn}) =>
      track('app_opened', params: {'signed_in': signedIn});

  /// The app is quitting, after [open]. Sent on the way out, so it is the last
  /// thing the queue drains.
  void appClosed({required Duration open}) =>
      track('app_closed', params: {'open_seconds': open.inSeconds});

  /// A screen was opened. [screen] is the section's stable name, never its
  /// label — labels are rewritten weekly and a renamed label would read as a
  /// new screen.
  ///
  /// [source] is the DOOR that was used, and it is `required` for the reason
  /// `new_agent_opened`'s is: a screen with several ways in tells you almost
  /// nothing as a bare count.
  ///
  /// Values: `account_menu` and `shortcut` (a door that OPENED Settings on this
  /// pane); `rail` (moved here from another pane, using the settings rail).
  void screenView(String screen, {required String source}) =>
      track('screen_view', params: {'screen': screen, 'source': source});

  // --- Sign-in ------------------------------------------------------------

  /// Sign-in completed.
  void signedIn() => track('signed_in');

  /// Sign-in didn't complete. [reason] is a short code — `cancelled`,
  /// `failed` — never the error text, which can carry a path or a host name.
  void signInFailed(String reason) =>
      track('sign_in_failed', params: {'reason': reason});

  /// The user signed out.
  void signedOut() => track('signed_out');

  /// First-run provisioning finished. [ready] is false when a required step
  /// could not be completed — which says how much of a fresh Mac this app can
  /// actually set up on its own, otherwise only visible in a support thread.
  void environmentPrepared({required bool ready}) =>
      track('environment_prepared', params: {'ready': ready});

  // --- Agents -------------------------------------------------------------
  //
  // How many people open the New agent dialog, how many of those finish it,
  // and how many of THOSE ever send the agent a message. Each step is a
  // separate event carrying the same device and user id, so the funnel is
  // built by counting distinct people per step.

  /// The New agent dialog was opened. [source] is which door was used —
  /// `machine_row` (the `+` on a machine's row), `rail_empty` (the button the
  /// empty rail shows), `pane_empty` (the button in the empty centre pane) or
  /// `shortcut` (⌘N and the app menu).
  ///
  /// Sent by `showNewAgentDialog` itself rather than by its callers, so a door
  /// added later cannot forget to report itself.
  void newAgentOpened({required String source}) =>
      track('new_agent_opened', params: {'source': source});

  /// An agent was created from the New agent dialog. [engine] is the engine id
  /// and [bypassPermission] whether its own guardrails were switched off, both
  /// product facts.
  ///
  /// The working folder is deliberately absent: it is an absolute path, which
  /// this stream never carries.
  void agentCreated({required String engine, required bool bypassPermission}) =>
      track(
        'agent_created',
        params: {'engine': engine, 'bypass_permission': bypassPermission},
      );

  /// The first message of a signed-in session — how long it took this person to
  /// get from being logged in to actually talking to an agent, whichever agent
  /// that turned out to be.
  ///
  /// **Once per sign-in, not per agent.** Which agent it was is
  /// [agentCreated]'s question; this one is about the gap at the top of the
  /// funnel, where somebody signs in and then does nothing.
  ///
  /// [from] says what started the clock, because the two populations behave
  /// nothing alike: `sign_in` is a fresh log-in, `launch` is opening the app
  /// with a session already on the machine. Averaging them together would hide
  /// both.
  ///
  /// Driven by the CLI's `turn_started`, not by the composer, so a message
  /// typed straight into the terminal counts the same as one sent from the box
  /// underneath it — which is how most people drive these engines.
  ///
  /// ⚠️ **No message text, ever**, and no agent, machine or folder either. Who
  /// it was and when are already on every event (`user_email`,
  /// `event_timestamp`); what this adds is the wait.
  void appFirstMessage({
    required String from,
    required int secondsSinceLogin,
  }) => track(
    'app_first_message',
    params: {'from': from, 'seconds_since_login': secondsSinceLogin},
  );
}
