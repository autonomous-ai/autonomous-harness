import 'dart:io';

/// True inside `flutter test`, which sets `FLUTTER_TEST` for every test process.
///
/// Widget tests here mount real screens and drive real controllers, so anything
/// that would reach outside the process on construction has to ask first. Two
/// separate reasons, and a thing that polls has both:
///
/// * **It must not act.** A test must not open a socket, shell out, or read a
///   real `~/.harness` — the run would depend on the machine it happens to be
///   on, and on whoever is signed in there.
/// * **It must not tick.** `pumpAndSettle` waits for the frame queue to go
///   quiet, and a `Timer.periodic` never lets it, so one background poll times
///   out every test that mounts the widget holding it.
///
/// One definition rather than a `FLUTTER_TEST` literal at each site: the two
/// call sites are asking the same question, and a second copy is a second thing
/// to get wrong.
final bool kUnderTest = Platform.environment.containsKey('FLUTTER_TEST');
