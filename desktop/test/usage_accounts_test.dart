// One figure per ACCOUNT, not per machine: a rate limit belongs to a
// subscription, so three machines on one Claude account are one budget — and a
// machine on another account is a second budget somebody can run out of.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/usage_accounts.dart';
import 'package:harness/usage/usage_window.dart';

ProviderUsage _reading(
  UsageProvider provider,
  double percent, {
  String? account,
}) => ProviderUsage(
  provider: provider,
  status: UsageStatus.ok,
  windows: [UsageWindow(label: kWeeklyWindowLabel, usedPercent: percent)],
  account: account,
);

ProviderUsage _signedOut(UsageProvider provider, {String? account}) =>
    ProviderUsage(
      provider: provider,
      status: UsageStatus.signedOut,
      account: account,
    );

List<UsageAccount> _claude(List<UsageAccount> accounts) => [
  for (final account in accounts)
    if (account.provider == UsageProvider.claude) account,
];

void main() {
  test('a remote machine on this same account is this figure again', () {
    final accounts = groupUsageAccounts(
      [_reading(UsageProvider.claude, 42, account: 'k1')],
      [
        MachineUsage(
          machineName: 'box',
          readings: [_reading(UsageProvider.claude, 42, account: 'k1')],
        ),
      ],
    );

    final claude = _claude(accounts);
    expect(claude, hasLength(1));
    expect(claude.single.isLocal, isTrue);
    // Worth saying in the panel, never on the strip.
    expect(claude.single.machines, ['box']);
  });

  test('a remote machine on another account is a figure of its own', () {
    final accounts = groupUsageAccounts(
      [_reading(UsageProvider.claude, 42, account: 'k1')],
      [
        MachineUsage(
          machineName: 'box',
          readings: [_reading(UsageProvider.claude, 71, account: 'k2')],
        ),
      ],
    );

    final claude = _claude(accounts);
    expect(claude.map((a) => a.isLocal), [true, false]);
    expect(claude.last.machines, ['box']);
    expect(claude.last.reading.railWindow?.usedPercent, 71);
  });

  test('two remote machines on one other account are one figure', () {
    final accounts = groupUsageAccounts(
      [_reading(UsageProvider.claude, 42, account: 'k1')],
      [
        MachineUsage(
          machineName: 'box-a',
          readings: [_reading(UsageProvider.claude, 71, account: 'k2')],
        ),
        MachineUsage(
          machineName: 'box-b',
          readings: [_reading(UsageProvider.claude, 71, account: 'k2')],
        ),
      ],
    );

    final claude = _claude(accounts);
    expect(claude, hasLength(2));
    expect(claude.last.machines, ['box-a', 'box-b']);
  });

  test('an account nobody can name is never merged with anything', () {
    // Two readings nobody can name are not provably one account, and merging
    // them could hide a subscription that is running out.
    final accounts = groupUsageAccounts(
      [_reading(UsageProvider.claude, 42)],
      [
        MachineUsage(
          machineName: 'box-a',
          readings: [_reading(UsageProvider.claude, 42)],
        ),
        MachineUsage(
          machineName: 'box-b',
          readings: [_reading(UsageProvider.claude, 42)],
        ),
      ],
    );

    expect(_claude(accounts), hasLength(3));
  });

  test('a token that expired here does not swallow a live remote reading', () {
    // Same account, but this computer has no figures for it. Folding the
    // remote reading into a blank would leave the strip empty while the
    // numbers were sitting in the reply.
    final accounts = groupUsageAccounts(
      [_signedOut(UsageProvider.claude, account: 'k1')],
      [
        MachineUsage(
          machineName: 'box',
          readings: [_reading(UsageProvider.claude, 64, account: 'k1')],
        ),
      ],
    );

    final claude = _claude(accounts);
    expect(claude.map((a) => a.isLocal), [true, false]);
    expect(claude.last.reading.hasFigures, isTrue);
  });

  test('a remote machine signed in to nothing adds nothing', () {
    final accounts = groupUsageAccounts(
      [_reading(UsageProvider.claude, 42, account: 'k1')],
      [
        MachineUsage(
          machineName: 'box',
          readings: [_signedOut(UsageProvider.claude)],
        ),
      ],
    );

    expect(_claude(accounts), hasLength(1));
  });

  test('a provider only a remote machine has still shows', () {
    final accounts = groupUsageAccounts(
      [_reading(UsageProvider.claude, 42, account: 'k1')],
      [
        MachineUsage(
          machineName: 'box',
          readings: [_reading(UsageProvider.codex, 9, account: 'c1')],
        ),
      ],
    );

    final codex = [
      for (final a in accounts)
        if (a.provider == UsageProvider.codex) a,
    ];
    expect(codex.single.isLocal, isFalse);
    expect(codex.single.machines, ['box']);
  });

  test('this computer comes first, providers in their own order', () {
    final accounts = groupUsageAccounts(
      [
        _reading(UsageProvider.claude, 42, account: 'k1'),
        _reading(UsageProvider.codex, 9, account: 'c1'),
      ],
      [
        MachineUsage(
          machineName: 'box',
          readings: [_reading(UsageProvider.claude, 71, account: 'k2')],
        ),
      ],
    );

    expect(
      accounts.map((a) => '${a.provider.name}:${a.isLocal ? 'here' : 'box'}'),
      ['claude:here', 'claude:box', 'codex:here'],
    );
  });
}
