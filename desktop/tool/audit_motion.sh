#!/usr/bin/env bash
#
# Guards the motion system in lib/ against the four ways it drifts.
#
# All four are things that happened to the app this repo's design system was
# distilled from (see .claude/flutter-desktop-animation-system.md §11): a
# duration typed by hand next to a token that already holds it, a curve typed
# by hand, a loop that never learned about Reduce Motion, a loop that dirties
# the whole window sixty times a second. None of them is a bug the day it
# lands, which is exactly why nothing catches them without this.
#
# Two things it CANNOT see, so read the output rather than trusting the exit
# code blindly:
#
#   1. It checks FILES, not widgets. A widget that drives an animation but
#      hands the painting to a child that already has a RepaintBoundary is a
#      false positive here.
#   2. grep has no idea about context. `Curves.easeOutCubic` in a
#      `switchInCurve` is legitimate (§3.2) and is excluded by the word
#      boundary, but a new legitimate exception will need adding by hand —
#      add the exception, don't loosen the rule.
#
# Run: tool/audit_motion.sh   (CI, or before reviewing anything that moves)
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

# The file that DEFINES the tokens is allowed to hold their values.
TOKENS=lib/shared/theme/app_theme.dart

echo "── a duration typed by hand where a token already holds it ──"
# Only animation parameters: a `Future.delayed(300ms)` waiting on a socket is
# not motion and must not be dragged into the motion scale.
if grep -rnE '(duration|reverseDuration): *const Duration\(milliseconds: (110|130|160|220|300)\)' \
     lib --include='*.dart' | grep -v "^$TOKENS:"; then
  echo "❌ use AppMotion.{press,hover,swap,fold,meter}"; fail=1
fi

echo "── the app's curve, typed by hand ──"
if grep -rnE 'Curves\.easeOut\b' lib --include='*.dart' | grep -v "^$TOKENS:"; then
  echo "❌ use AppMotion.curve"; fail=1
fi

echo "── a loop that ignores Reduce Motion ──"
while IFS= read -r f; do
  grep -q 'disableAnimations' "$f" || { echo "❌ $f"; fail=1; }
done < <(grep -rl '\.repeat(' lib --include='*.dart')

echo "── a loop with no RepaintBoundary ──"
while IFS= read -r f; do
  grep -q 'RepaintBoundary' "$f" || { echo "⚠️  $f — check whether a child holds the boundary"; fail=1; }
done < <(grep -rl '\.repeat(' lib --include='*.dart')

echo "── a controller with no dispose ──"
while IFS= read -r f; do
  c=$(grep -c 'AnimationController(' "$f")
  d=$(grep -c '\.dispose()' "$f")
  [ "$d" -ge "$c" ] || { echo "❌ $f (controllers=$c dispose=$d)"; fail=1; }
done < <(grep -rl 'AnimationController' lib --include='*.dart')

[ "$fail" -eq 0 ] && echo "✅ motion clean"
exit "$fail"
