#!/usr/bin/env bash
# Build the Android App Bundle for Google Play. `bash mobile/scripts/release-android.sh`
#
# Builds and checks; it does not upload. Play Console ▸ OpenHarness ▸ Testing / Production ▸ Create
# release takes the .aab this prints — see mobile/RELEASE.md, "Android".
#
# ⚠️ THE VERSION CODE IS THE WHOLE GAME, as the build number is on iOS: Play refuses a versionCode it
# has already seen. It is the `+N` in pubspec.yaml, shared with the iOS builds: each store keeps its
# own count, so one `+N` can go to both, and it is bumped after an upload to either.
#
# Signing: the upload key and its passwords live OUTSIDE this public repo, in
# ~/.android-release/harness-upload.properties (HARNESS_ANDROID_SIGNING overrides the path). Without
# them android/app/build.gradle.kts falls back to the debug key, which Play refuses — so this script
# stops before building rather than hand you a bundle that cannot be uploaded.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # mobile/
cd "$ROOT"

SIGNING="${HARNESS_ANDROID_SIGNING:-$HOME/.android-release/harness-upload.properties}"
if [[ ! -f "$SIGNING" ]]; then
  echo "no upload key: $SIGNING is missing." >&2
  echo "see mobile/RELEASE.md, \"Android\", for where it comes from." >&2
  exit 1
fi
prop() { sed -n "s/^$1=//p" "$SIGNING" | head -1; }

VERSION="$(sed -n 's/^version: *//p' pubspec.yaml | head -1)"
echo "==> version ${VERSION%%+*}, versionCode ${VERSION##*+}"
echo "    Play must not already hold versionCode ${VERSION##*+}."

echo "==> flutter build appbundle"
flutter build appbundle --release

AAB="build/app/outputs/bundle/release/app-release.aab"
[[ -f "$AAB" ]] || { echo "no bundle at $AAB" >&2; exit 1; }

# The fallback to the debug key is silent inside Gradle, so ask the bundle who signed it.
fingerprint() { sed -n 's/^.*SHA256: *//p' | head -1; }
SIGNED_BY="$(keytool -printcert -jarfile "$AAB" | fingerprint)"
EXPECTED="$(keytool -list -v -keystore "$(prop storeFile)" -alias "$(prop keyAlias)" \
  -storepass "$(prop storePassword)" | fingerprint)"
if [[ -z "$SIGNED_BY" || "$SIGNED_BY" != "$EXPECTED" ]]; then
  echo "!!  $AAB is not signed with the upload key (signer: ${SIGNED_BY:-none})." >&2
  echo "    Play would refuse it. Check $SIGNING." >&2
  exit 1
fi

cat <<EOF

Built $AAB
  versionCode ${VERSION##*+}, signed with the upload key ($EXPECTED)

Not uploaded. Play Console -> OpenHarness -> Test and release -> Internal testing (or Production)
-> Create new release -> upload this file. Then bump the +N in pubspec.yaml.
EOF
