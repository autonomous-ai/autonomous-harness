// The device row's column is the account row's column — measured, not eyeballed.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/dial_status.dart';
import 'package:harness/widgets/account_footer.dart';
import 'package:harness/widgets/device_row.dart';

void main() {
  testWidgets('the dot and the text sit on the avatar and the email', (
    tester,
  ) async {
    // The two pills share a left column or they read as two row types. The first cut put the mark
    // in a 26px box because that is what the account pill LOOKS like; the avatar is 32, and the
    // six-pixel miss was visible from across the room. So this measures, in pixels.
    final n = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    )..dial.apply(const DialStatus(attached: true));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              SizedBox(width: 264, child: DeviceRow(notifier: n)),
              SizedBox(width: 264, child: AccountFooter(notifier: n)),
            ],
          ),
        ),
      ),
    );
    await tester.pump();
    final dot = tester.getCenter(find.byKey(const Key('device-dot')));
    final avatar = tester.getCenter(find.byKey(const Key('account-avatar')));
    expect(
      dot.dx,
      closeTo(avatar.dx, 0.5),
      reason: 'mark centre vs avatar centre',
    );
    final label = tester.getTopLeft(find.text('Harness device'));
    // Signed out in a test, the pill prints its fallback where the email goes; same column.
    final email = tester.getTopLeft(find.text('signed in'));
    expect(
      label.dx,
      closeTo(email.dx, 0.5),
      reason: 'label left vs email left',
    );
  });
}
