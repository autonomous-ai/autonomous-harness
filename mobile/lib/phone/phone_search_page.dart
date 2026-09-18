import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'phone_navigation.dart';
import 'phone_search_field.dart';
import 'phone_search_rank.dart';
import 'phone_search_results.dart';

/// One query over every agent the account can reach. Machines are not searched
/// here — they are on the terminal's `⋯` sheet.
///
/// A screen of its own rather than a field above either list, and that is the
/// whole point: the two tabs each answer half the question, and somebody who
/// remembers "that review thing" does not know which half holds it. This is the
/// phone's version of the desktop's Open Agent picker, down to the ranking — the
/// two share [phoneFieldMatchScore] so a query that finds an agent on the laptop
/// finds the same agent here.
///
/// ⚠️ Keystrokes never ask a machine anything. They filter what the app already
/// holds — the agent list, and the recall [PhoneSearchResults] fetched once as
/// the search opened — so typing on two bars of signal stays instant.
///
/// Returns when the search closes, so a caller whose own chrome depends on
/// being the top route can rebuild — see `terminal_page.dart`, where the header
/// buttons hide behind a keyboard this page did not raise.
Future<void> openPhoneSearch(BuildContext context, AppNotifier notifier) =>
    Navigator.of(context)
        .push(phoneRoute((_) => PhoneSearchPage(notifier: notifier)));

class PhoneSearchPage extends StatefulWidget {
  const PhoneSearchPage({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<PhoneSearchPage> createState() => _PhoneSearchPageState();
}

class _PhoneSearchPageState extends State<PhoneSearchPage> {
  final _controller = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Phone search');
  String _query = '';

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      // The keyboard is up for this page's whole life, so the body must shrink
      // rather than let the list run underneath it.
      resizeToAvoidBottomInset: true,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            PhoneSearchField(
              controller: _controller,
              focus: _focus,
              onChanged: (value) => setState(() => _query = value),
              onClear: () {
                _controller.clear();
                setState(() => _query = '');
                // Clearing is a step back into browsing, not out of the
                // screen — the caret stays where the next query will go.
                _focus.requestFocus();
              },
              onBack: () => Navigator.of(context).maybePop(),
            ),
            Expanded(
              child: PhoneSearchResults(
                notifier: widget.notifier,
                query: _query,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
