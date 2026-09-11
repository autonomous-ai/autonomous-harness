import 'usage_window.dart';

/// One remote machine's answer to `usage_read`: what ITS agent accounts have
/// spent, read there with its own credentials.
class MachineUsage {
  const MachineUsage({required this.machineName, required this.readings});

  /// How the machine is named on screen — the strip's label for a figure that
  /// is not this computer's.
  final String machineName;

  final List<ProviderUsage> readings;
}

/// One account's figures, and where it was seen.
class UsageAccount {
  const UsageAccount({
    required this.reading,
    required this.isLocal,
    this.machines = const [],
  });

  final ProviderUsage reading;

  /// This computer's own account. The strip never labels it: it is the figure
  /// a person reads as "mine" without being told.
  final bool isLocal;

  /// The remote machines signed in to this account, in the order they
  /// answered. For the local account these are the machines that turned out to
  /// share it — worth saying in the panel, never on the strip.
  final List<String> machines;

  UsageProvider get provider => reading.provider;
}

/// Every account worth a figure: ONE per account, however many machines are
/// signed in to it.
///
/// A rate limit belongs to an account rather than to a computer, so three
/// machines on one Claude subscription are one figure — printing three would
/// triple-count a single budget. A machine on a DIFFERENT subscription is a
/// figure of its own, because that is a second budget somebody can run out of.
///
/// Per provider, in [UsageProvider] order: this computer's account first, then
/// each distinct remote account. Only remote readings with figures are
/// considered — a machine signed in to nothing has nothing to add, and saying
/// so for every machine on the account would fill the panel with apologies.
///
/// ⚠️ **A null account never matches**, itself included (see
/// [ProviderUsage.account]). Two readings nobody can name are not provably one
/// account, and merging them could hide a subscription that is running out.
List<UsageAccount> groupUsageAccounts(
  List<ProviderUsage> local,
  List<MachineUsage> remote,
) {
  final accounts = <UsageAccount>[];
  for (final provider in UsageProvider.values) {
    final own = _readingFor(local, provider);
    final sharedWithOwn = <String>[];
    final others = <_Group>[];
    for (final machine in remote) {
      final reading = _readingFor(machine.readings, provider);
      if (reading == null || !reading.hasFigures) continue;
      final key = reading.account;
      // ⚠️ Merged into this computer's figure only when that figure EXISTS.
      // Otherwise a Claude token that expired here would swallow the live
      // reading a remote machine took of the very same account, and the strip
      // would go blank while the numbers were sitting in the reply.
      if (key != null && own != null && own.hasFigures && key == own.account) {
        sharedWithOwn.add(machine.machineName);
        continue;
      }
      final existing = key == null
          ? null
          : _firstWhereOrNull(others, (group) => group.key == key);
      if (existing != null) {
        existing.machines.add(machine.machineName);
      } else {
        others.add(_Group(key, reading, [machine.machineName]));
      }
    }
    if (own != null) {
      accounts.add(
        UsageAccount(reading: own, isLocal: true, machines: sharedWithOwn),
      );
    }
    for (final group in others) {
      accounts.add(
        UsageAccount(
          reading: group.reading,
          isLocal: false,
          machines: group.machines,
        ),
      );
    }
  }
  return accounts;
}

class _Group {
  _Group(this.key, this.reading, this.machines);

  final String? key;
  final ProviderUsage reading;
  final List<String> machines;
}

ProviderUsage? _readingFor(
  List<ProviderUsage> readings,
  UsageProvider provider,
) => _firstWhereOrNull(readings, (reading) => reading.provider == provider);

/// A plain loop rather than `firstWhereOrNull`: `package:collection` is not a
/// dependency of this project, and a three-line lookup is not worth adding one.
T? _firstWhereOrNull<T>(Iterable<T> items, bool Function(T) test) {
  for (final item in items) {
    if (test(item)) return item;
  }
  return null;
}
