import 'package:flutter/material.dart';

import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../../state/app_state.dart';

class AccountSection extends StatelessWidget {
  const AccountSection({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) {
      final local = notifier.localManualFixture != null;
      final profile = notifier.currentUser;
      return SectionScaffold(
        title: 'Account',
        subtitle: local
            ? 'Connected to a local development session.'
            : 'Your Harness sign-in on this computer.',
        child: SingleChildScrollView(
          child: SettingRow(
            title:
                profile?.displayName ?? (local ? 'Local session' : 'Signed in'),
            detail:
                profile?.email ??
                (local ? 'Loopback backend' : 'Profile unavailable'),
            control: OutlinedButton(
              key: const Key('settings-sign-out-button'),
              onPressed: () {
                Navigator.of(context).pop();
                notifier.logout();
              },
              child: Text(local ? 'Disconnect local session' : 'Sign out'),
            ),
          ),
        ),
      );
    },
  );
}
