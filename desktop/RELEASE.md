# Releasing the desktop app

Running apps self-update from a public GCS bucket (`lib/update/desktop_updater.dart`). Releasing is
pushing a tag: `../.github/workflows/release-desktop.yml` builds both macOS builds (Intel on Skia,
Apple Silicon on Impeller — see "Two macOS builds" below) and both Linux architectures, publishes them
to that bucket, and cuts the GitHub Release. **The tag IS the version — CI never bumps.**

Tags are `vX.Y.Z_desktop`, not plain `vX.Y.Z`: the CLI (`cli/`, tags `vX.Y.Z_cli`) and the backend
(`backend/`, tags `vX.Y.Z_api`) release from this same repo, so the suffix is what tells each
tag-push trigger which workflow to run. It is stripped before anything treats it as a version — the
manifest, `--build-name`, the release title and the updater's comparison all see a bare `X.Y.Z`.

```bash
# from the repo root (or `cd desktop && make release ...`, which is the same script)
make release-desktop                       # bump the patch, tag, push — CI does the rest
make release-desktop ARGS="--dry-run"      # print the version it would cut and the notes, do nothing
make release-desktop ARGS="--minor"        # bump the MINOR version, per the usual semver convention
make release-desktop ARGS="1.3.0"          # release an explicit version
make release-desktop ARGS="--notes-file notes.md"   # hand-written release notes
```

Nothing is built locally and no GCS credentials are needed: the only things the script touches are
git and a public HTTPS read of the manifest.

**Why the version comes from two places.** `scripts/release-desktop.sh` takes the highest of the last
git tag and the highest version in the live `metadata.json`, across every `desktop-*` key. Publishing
used to be a local command that bumped from the manifest and tagged nothing, so the two drifted: this
repo once had a single tag `v1.0.52` while the manifest was already serving `1.0.61`. Bumping from
tags alone there produces a version LOWER than what users run — every app refuses it (`semverGt`)
while the release still reports success. That local path is gone; the tag is now the only way in.

`pubspec.yaml`'s `version:` field is never touched; it's a dev-only placeholder.

## Managed Node runtime

Node lives under `~/.harness/runtime` and does not alter the user's system Node, Homebrew, nvm, or
shell PATH. That is the point of it — the CLI launcher is written against that exact binary, so a
Finder launch (where PATH is launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin`) and a Terminal launch
behave identically.

**The desktop app no longer installs it; the `harness` installer does** — for the app's first run and
for a terminal install alike. This repo still owns the *publishing*, so the command below is unchanged
and still has to be run before a release needs a newer Node. Publish macOS and Linux
archives for both ARM64 and x64 (including machines where `uname -m` reports `amd64`) before
releasing a desktop build that requires a new Node version:

```bash
make upload-node-runtime ARGS="22.23.2"
```

The publisher downloads the official Node archives and `SHASUMS256.txt`, verifies each archive before
uploading, then atomically merges `harness/runtime/metadata.json`. The app verifies the manifest's
size and SHA-256 again before extracting an archive. A runtime manifest applies to fresh installs;
roll out a changed runtime to existing users with a newer desktop build. Never replace an existing
versioned archive in place.

Until that managed manifest covers a platform, the desktop build falls back to its checksum-pinned
official Node 22 archive for it. The fallback keeps first-run setup functional but is intentionally
not a replacement for publishing the managed runtime channel before release.

Homebrew and `apt` are still used for **tmux**, which is a separate step and unrelated to Node.

## Two macOS builds — Intel on Skia, Apple Silicon on Impeller

Every release ships the macOS app **twice**: the same universal (arm64 + x86_64) build of the same
commit, differing in one Info.plist key, `FLTEnableImpeller` — which renderer Flutter draws with.

| Build | Renderer | Manifest keys | Files | Installed by |
|---|---|---|---|---|
| Intel | Skia (`FLTEnableImpeller = false`) | `desktop-macos`, `desktop-macos-dmg` | `Harness-macos.{zip,dmg}` | Intel Macs, **every install from before the split on either CPU**, and the website download |
| Apple Silicon | Impeller (the engine default) | `desktop-macos-arm64`, `desktop-macos-arm64-dmg` | `Harness-macos-arm64.{zip,dmg}` | Apple Silicon Macs whose updater knows the key |

`scripts/publish-macos-variant.sh intel|apple-silicon <version>` builds and publishes one of them;
`release-desktop.yml` runs both side by side.

**Why.** Intel users report the app stuttering; Apple Silicon users do not. Flutter renders macOS with
Impeller by default, and the one thing that differs between those two users running the same universal
build is the GPU Impeller drives — so the Intel build opts out. A release build can only opt out through
Info.plist: the engine compiles its command-line switches out of release (`GetSwitchesFromEnvironment`),
and an Info.plist belongs to a bundle, so choosing by CPU means shipping two bundles. The x86_64 code an
Intel Mac runs is identical in both — the split is about the renderer, not the CPU slices; a universal
build was already native on Intel.

**Why both stay universal.** The Intel build carries the key every older install polls, Apple Silicon
ones included, so it has to launch on both. The Apple Silicon build stays universal so a Mac running it
under Rosetta, or a DMG handed to the wrong person, still launches.

**Why the Intel build kept the old key and file name.** `desktop-macos` is what every install before the
split polls, and `desktop-macos-dmg` is what `harness.autonomous.ai/desktop/download-macos` serves. The
Skia build there fixes every Intel Mac on its next update, with no new updater needed first, and hands a
new visitor a build that works on whatever Mac they have — so the website needed no change. The cost is
one release on Skia for an Apple Silicon Mac arriving from an old build or from the website: the build
it lands on already asks for `desktop-macos-arm64`, and moves onto Impeller at the next release (not the
same one — the updater only ever moves to a strictly newer version).

**How the updater picks** (`DesktopUpdater._otaKeys`). An Intel Mac reads `desktop-macos` only — the
arm64 build renders on exactly what it must not, however new. Apple Silicon reads both and takes the
**newer**, `desktop-macos-arm64` winning a tie: a release that published both installs the Impeller
build, and one that only moved `desktop-macos` (a hand publish that stopped halfway, say) still reaches
it rather than hiding behind an older arm64 entry.

**TODO(BE): this is a workaround, not a diagnosis, and it has a real cost.** Every machine this app is
developed on is Apple Silicon, on Impeller, so Intel users now run a renderer nobody here looks at, and a
Skia-only rendering bug reaches them unseen. Nothing here has measured that Skia cures the stutter
either — confirm it with an Intel user on the first release that carries it, and if they still stutter
on Skia, the renderer was not the cause and this split should go. The Grid app is the precedent both
ways: it added this exact opt-out for Intel (`autonomous-grid-app` `87def3c6`) and removed it the same
day (`58687e7f`), because its real cause turned out to be CI shipping a newer Flutter than the team ran,
fixed by pinning. Harness's release already builds with the Flutter it is developed on (`FLUTTER_VERSION` in
`release-desktop.yml`), so that cause
does not apply here. **Re-check on every Flutter bump**: the engine reads `FLTEnableImpeller` in
`FlutterDartProject.mm`, and the day that read goes away the Intel build silently goes back to Impeller.

## Publishing by hand

`scripts/publish-macos-variant.sh` (one macOS build per run) and `scripts/upload-desktop-linux.sh` are
the publishing steps. The macOS one builds and pins the renderer, then hands the bundle to
`scripts/upload-desktop.sh --no-build`, which does everything after the build exactly as it always has.
CI runs them with the version taken from the tag, and they are also reachable directly when CI cannot be:

```bash
make upload-desktop VERSION=1.3.0                          # both macOS builds, Intel first
make upload-desktop VERSION=1.3.0 ARGS="--no-notarize"     # the same, Developer ID signed only
bash scripts/publish-macos-variant.sh intel 1.3.0          # one macOS build
bash scripts/publish-macos-variant.sh apple-silicon 1.3.0
bash scripts/publish-macos-variant.sh intel 1.3.0 --build-only   # build + pin the renderer, publish nothing
make upload-desktop-linux ARCH=arm64                       # per Linux architecture
```

**macOS takes an explicit version.** Two runs have to publish one version, and `upload-desktop.sh`'s own
auto-bump reads the manifest — the second run would see the first one's upload and bump again.
`make release-desktop ARGS="--dry-run"` prints the next one. ⚠️ `upload-desktop.sh` run on its own still works,
and is now wrong: it builds without the renderer pin and writes `desktop-macos`, which puts **Impeller**
back on every Intel Mac. Go through `publish-macos-variant.sh`.

**These create no git tag**, so the repo stops reflecting what is published — one tag, `v1.0.52`, once
sat nine releases behind a manifest already serving `1.0.61`. Prefer `make release-desktop`; if you do publish
by hand, cut a `make release-desktop` afterwards to bring the tag back in line, and remember it only publishes
the platform you ran it on.

For one macOS build, `publish-macos-variant.sh`:

1. Takes the build (`intel` / `apple-silicon`) and the version it was given (CI passes the tag's
   `X.Y.Z`).
2. Runs `flutter build macos --release --build-name=<version> --build-number=<n>` — the version is
   stamped into the bundle's `Info.plist` at build time, not read from any file.
3. Pins the renderer. **Intel:** writes `FLTEnableImpeller = false`, reads it back, and re-signs the
   outer bundle — the edit broke Xcode's seal — keeping the identity, hardened runtime and entitlements
   Xcode signed it with, and failing if the entitlements come out different. **Apple Silicon:** writes
   nothing, and fails if the key is there, so an opt-out committed to `macos/Runner/Info.plist` cannot
   quietly put it on Skia. Both then verify the signature and the hardened runtime.
4. Hands the bundle to `upload-desktop.sh --no-build` with that build's keys and file names (`OTA_KEY`,
   `DMG_KEY`, `GCS_PATH`, `DMG_GCS_PATH` — set per build, so two runs cannot write each other's), which:
5. Asserts the built bundle's `CFBundleShortVersionString` really carries that version before
   publishing anything.
6. Packages the `.app` with `ditto -c -k --sequesterRsrc --keepParent` (keeps the bundle structure and
   extended attributes intact — a plain `zip` does not).
7. Notarizes the zip, staples the ticket into the `.app`, re-zips from the stapled bundle, and
   asserts Gatekeeper accepts it (`spctl`).
8. Packages a `.dmg` from that same stapled bundle — a staging folder holding `Harness.app` plus an
   `/Applications` symlink, imaged with `hdiutil` — then signs, notarizes and staples the image too.
9. Uploads **both** artifacts with a year-long immutable `Cache-Control` (see "GCS layout").
10. Download-merge-reuploads `metadata.json` in a single write, touching only that build's two keys.

A failed build stops the release; nothing is uploaded and no version is consumed.

### One build, two artifacts — per macOS build — and why the dmg is separate

Each macOS build is one `flutter build` and one signature. Its dmg is cut from the bundle its zip was
cut from, after stapling — an app stapled afterwards would leave the image carrying an unstapled copy
that Gatekeeper can only clear by calling Apple on first launch.

The two artifacts serve different jobs and must not be merged:

- **zip / `desktop-macos`, `desktop-macos-arm64`** — what `DesktopUpdater` consumes. It unpacks with
  `ditto -x -k` and then `mv`s the running bundle in place. It has no code path for a disk image, and a
  mounted dmg volume is read-only, so it could not host the app it is asked to replace.
- **dmg / `desktop-macos-dmg`, `desktop-macos-arm64-dmg`** — what a person downloads and drags into
  Applications. Nothing in the app ever reads these keys.

Expect **two notarization submissions per build — four per release**, the two builds in parallel on CI.
They cannot be collapsed: stapling only attaches a ticket to the exact artifact submitted, so the zip's
ticket does not cover the image. The second pass is usually quick because Apple has already seen that
app's cdhash.

Publishing also refreshes the public download link with no web deploy: `harness.autonomous.ai/desktop/download-macos`
(in `autonomous-code`, `apps/web/src/app/desktop/download-macos/`) resolves `desktop-macos-dmg` — the
Intel build, which runs on any Mac — from this same manifest on every request, so the new version is
live the moment step 10 lands. Offering the Apple Silicon dmg there is a change in that repo, not this
one.

## GCS layout

```
gs://s3-autonomous-upgrade-3/harness/desktop/metadata.json
gs://s3-autonomous-upgrade-3/harness/desktop/<version>/Harness-macos.zip         (Intel build, Skia)
gs://s3-autonomous-upgrade-3/harness/desktop/<version>/Harness-macos.dmg
gs://s3-autonomous-upgrade-3/harness/desktop/<version>/Harness-macos-arm64.zip   (Apple Silicon build, Impeller)
gs://s3-autonomous-upgrade-3/harness/desktop/<version>/Harness-macos-arm64.dmg
```

The manifest is always read straight off the GCS origin (`CDN_ASSET_BASE_URL` in `upload-desktop.sh`/
`upload-desktop-linux.sh` does not apply to it) — it's polled every ~60s by every running app, and this
product's CDN caps any cacheable response at ~31 days regardless of origin headers, so it must never be
CDN-fronted. The zip/dmg/AppImage it points at are the opposite: immutable once published, so their
`url` fields point at `cdn.autonomous.ai` instead, and are uploaded with a long `Cache-Control` on
purpose.

```json
{
  "desktop-macos": {
    "version": "1.2.4",
    "url": "https://cdn.autonomous.ai/harness/desktop/1.2.4/Harness-macos.zip",
    "sha256": "<64 hex>",
    "size": 45231920
  },
  "desktop-macos-dmg": {
    "version": "1.2.4",
    "url": "https://cdn.autonomous.ai/harness/desktop/1.2.4/Harness-macos.dmg",
    "sha256": "<64 hex>",
    "size": 47118336
  },
  "desktop-macos-arm64": {
    "version": "1.2.4",
    "url": "https://cdn.autonomous.ai/harness/desktop/1.2.4/Harness-macos-arm64.zip",
    "sha256": "<64 hex>",
    "size": 45231920
  },
  "desktop-macos-arm64-dmg": {
    "version": "1.2.4",
    "url": "https://cdn.autonomous.ai/harness/desktop/1.2.4/Harness-macos-arm64.dmg",
    "sha256": "<64 hex>",
    "size": 47118336
  }
}
```

The bucket must be public-read — that is bucket policy, not something the script sets.

## Signing — Developer ID, notarized

The Release build is signed with a real **Developer ID Application** certificate (team
`54DJVWMJCC`, "Autonomous Inc.") and notarized — a freshly downloaded copy (browser, Slack,
AirDrop — anything that sets the `com.apple.quarantine` extended attribute) passes Gatekeeper with
no "unidentified developer" prompt and no manual Open Anyway/`xattr -d` workaround needed.

What that takes, end to end:

- **The signing certificate** (`Developer ID Application: Autonomous Inc. (54DJVWMJCC)`) must be in
  the machine's **login** keychain — not the System keychain, which prompts for an admin password
  on every `codesign` invocation and breaks a non-interactive build. `security find-identity -v -p
  codesigning` should list it with no password needed to check.
- **`macos/Runner.xcodeproj`**'s Runner target Release config carries `CODE_SIGN_STYLE = Manual`,
  `CODE_SIGN_IDENTITY = "Developer ID Application"`, `DEVELOPMENT_TEAM = 54DJVWMJCC`,
  `ENABLE_HARDENED_RUNTIME = YES`, and `OTHER_CODE_SIGN_FLAGS = "--timestamp"` — notarization hard-
  rejects a signature with no secure timestamp ("Archive contains critical validation errors"), and
  Manual signing style doesn't request one on its own the way Automatic does.
- **`macos/Runner/Release.entitlements`** pins `com.apple.security.get-task-allow` to `false` —
  Flutter's build backend stamps this `true` regardless of build mode, and notarization rejects a
  debugger-attachable binary outright.
- **A `notarytool` keychain profile** must exist for the script's notarize step (see the comment
  block at the top of `scripts/upload-desktop.sh` for the one-time `store-credentials` setup —
  needs an app-specific password from appleid.apple.com, never the Apple ID's own password).

`scripts/upload-desktop.sh` submits the packaged zip to Apple's notary service (`notarytool submit
--wait`), staples the returned ticket onto the `.app` (`stapler staple` — this changes the bundle's
contents, so the zip is rebuilt from the stapled bundle before upload), and asserts `spctl -a`
accepts the result before publishing anything. Skip notarizing with `--no-notarize` (the build
stays Developer ID signed, just without Apple's ticket — more likely to prompt Gatekeeper on a copy
downloaded fresh by someone else, though probably still fine for the OTA self-update path below,
which doesn't reliably pick up the quarantine flag in the first place).

## How a running app self-updates

1. `DesktopUpdater` checks the manifest once on launch, then every minute
   (`lib/update/desktop_updater.dart`) — `desktop-macos` on an Intel Mac, the newer of
   `desktop-macos-arm64` and `desktop-macos` on Apple Silicon (see "Two macOS builds").
2. Compares against the running app's own version (`package_info_plus`) — strictly newer only, so
   republishing an old build cannot downgrade anyone.
3. After the user chooses **Update now**, downloads the zip and verifies its sha256 **before** anything is unpacked. A mismatch is discarded.
4. Unpacks into a staging directory and re-reads `CFBundleShortVersionString` from the staged bundle as
   a sanity check that the download really is the version it claims to be.
5. Checks on launch (including the sign-in screen) and every minute. When a newer build exists,
   it shows a non-blocking notification. The user chooses **Update now** to download and install it,
   or **Skip version** to silence that exact version. A later version is shown normally; the account
   menu also has **Check for updates** to revisit a skipped version.
6. On restart: a detached helper process waits for this app to exit, backs the current bundle up as
   `Harness.app.prev`, swaps the staged build into place, relaunches it, and — if the relaunched app
   doesn't stay alive a few seconds later — restores `Harness.app.prev` and relaunches the old build
   instead.

## Rolling out safely

Publish to a scratch manifest before touching the real one, and point a test build at it via
`--dart-define`. `release-desktop.yml` has a `workflow_dispatch` trigger that takes both the version and the
manifest to write, so a rehearsal never touches the real one:

```bash
gh workflow run release-desktop.yml -f version=1.3.0 -f metadata_path=harness/desktop/metadata-test.json
```

```bash
flutter run -d macos --dart-define=DESKTOP_UPDATE_METADATA_URL=https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/metadata-test.json
```

## Internal builds — an unlisted link, not a release

`../.github/workflows/desktop-internal-build.yml` builds any branch the way a release would — both macOS
builds, Developer ID signed, notarized, stapled and checked by Gatekeeper — and uploads them where
no running app and no public page will ever look:

```bash
git push origin HEAD:internal/<name>     # builds that commit: Debug off
gh workflow run desktop-internal-build.yml --ref <branch> -f debug_surface=false
```

(`workflow_dispatch` only exists once the file is on `main`; the `internal/**` push works from any
branch that carries it.) The run prints one `.dmg` link per build — as a notice at the top of the run
page, and in its summary — named `Harness-macos[-arm64]-<next version>-<commit>.dmg`.

- **Unlisted, not private — and this repository is public.** The files sit under
  `harness/desktop-internal/<128 random bits>/` and the bucket refuses anonymous listing, so a build
  cannot be found by guessing. The run page that prints its link is public, though, so anyone who
  opens it can download the build. The team chose that on 2026-09-10 over a key-derived link that only
  key holders could work out; if it stops being acceptable, that is the design to go back to.
- Take a build back with `gsutil -m rm -r gs://s3-autonomous-upgrade-3/harness/desktop-internal/<token>`
  (the summary prints it); the workflow strips the release's year-long cache headers from these files
  so a deletion sticks.
- **It never updates itself.** `DESKTOP_UPDATE_METADATA_URL` points at a manifest nothing writes,
  so a tester stays on the build they were asked to test rather than being moved onto the next
  public release. The next internal build is installed by its own link.
- **Same code path as a release, flags aside.** `publish-macos-variant.sh --build-only` builds and
  pins the renderer (its `--dart-define=` arguments go to `flutter build` and nowhere else), then
  `upload-desktop.sh --no-build` packages, notarizes and uploads, moved onto the internal prefix by
  its existing env overrides (`GCS_PATH`, `DMG_GCS_PATH`, `METADATA_PATH`). Its signing steps are the
  release's own `.github/actions/macos-signing`, so an internal build also proves those before a
  release depends on them.
- **Why not by hand.** An Info.plist edited and re-signed on a laptop reached a tester as "The
  application "Harness" can't be opened", and a laptop without the notarytool profile cannot
  notarize at all — which is what makes a copy downloaded fresh on another Mac open cleanly.

## Rollback

The relaunch-health check (step 6 above) only guards against a build that fails to start. To roll back
a build that starts but is otherwise broken, publish a **higher** version containing the older code —
the updater refuses to move backwards, so editing the manifest to an older version will not roll a
running app back.

## Linux

`scripts/upload-desktop-linux.sh` publishes architecture-specific Linux ARM64 and x64 releases to the
**same** `metadata.json` as macOS. `release-desktop.yml` runs it on both a `ubuntu-24.04` and a
`ubuntu-24.04-arm` runner, so one `make release-desktop` covers every build — which is also why the six
`desktop-*` keys only stay on one version when the release goes through CI. Run by hand
(`make upload-desktop-linux ARCH=arm64`) it moves one key and leaves the others behind. `amd64` and
`x86_64` are accepted aliases for `x64`; `aarch64` is accepted as an alias for `arm64`.

With no `ARCH`, the command detects the host architecture. A build must run on a matching
Ubuntu/Linux host because Flutter Linux desktop builds use the host architecture. `--no-build` can
package and upload an already-built bundle for the selected architecture. `APPIMAGETOOL` must point
at an executable `appimagetool-<x86_64|aarch64>.AppImage` — `release-desktop.yml` downloads a pinned one per
matrix job; running by hand, fetch one yourself from the
[AppImage/appimagetool releases](https://github.com/AppImage/appimagetool/releases).

**No signing/notarization step** — there is no Linux equivalent of Apple's Developer ID/notarization,
and none is needed: the trust boundary is the same sha256-verified manifest entry `DesktopUpdater`
already checks on every platform.

**Packaged as a single-file AppImage**, not a tarball. The script stages an AppDir
(`usr/bin/` = the Flutter `bundle/` verbatim, plus a hand-written `harness.desktop` and the
`harness.png` icon CMake already installs at the bundle root) and hands it to `appimagetool` with
`--appimage-extract-and-run`, so packaging needs no FUSE on the build host. `AppRun` is a plain
symlink to `usr/bin/harness` — the Flutter runner locates its own `lib/`/`data/` next to
`/proc/self/exe`, which resolves to the real binary after exec regardless of the symlink used to
launch it.

**No Info.plist-style version stamp.** `flutter build linux` has nowhere to stamp a version the way
Xcode does into `Info.plist`, so the release script writes a plain `version.txt` into the built
bundle (`build/linux/<arm64|x64>/release/bundle/version.txt`, which ends up at `usr/bin/version.txt`
inside the AppDir) and asserts it before packaging. `lib/core/app_version.dart` (what Settings ▸
About shows) reads this file back on Linux, falling through to `PackageInfo.fromPlatform()` (which
would otherwise just return `pubspec.yaml`'s never-bumped placeholder) everywhere else — this still
works unchanged for a *running* AppImage, since the AppImage runtime mounts the whole AppDir at a
temporary path and the app resolves `version.txt` relative to its own (mounted) executable exactly
as it did inside the old tarball. `lib/update/desktop_updater.dart`'s `downloadAndStage()` does
**not** re-verify this against the manifest for Linux — sha256 already authenticates the entire
single-file download, so there's nothing left inside it to disagree with the hash.

### GCS layout

```
gs://s3-autonomous-upgrade-3/harness/desktop/metadata.json          (shared with macOS, different key)
gs://s3-autonomous-upgrade-3/harness/desktop/<version>/Harness-linux-x64.AppImage
gs://s3-autonomous-upgrade-3/harness/desktop/<version>/Harness-linux-arm64.AppImage
```

```json
{
  "desktop-linux-x64": {
    "version": "1.2.4",
    "url": "https://cdn.autonomous.ai/harness/desktop/1.2.4/Harness-linux-x64.AppImage",
    "sha256": "<64 hex>",
    "size": 41230011
  }
}
```

### How a running Linux app self-updates

Same shape as macOS (see above), with the platform-specific pieces:

1. `DesktopUpdater` reads the `desktop-linux-arm64` or `desktop-linux-x64` manifest entry for its
   runtime architecture instead of `desktop-macos`.
2. The download IS the artifact — a single `.AppImage` file, made executable after its sha256
   verifies, with nothing to unpack.
3. On restart, the detached helper resolves the running AppImage's own path from the `APPIMAGE`
   environment variable (set by the AppImage runtime on launch — the process itself runs from a
   temporary FUSE mount, not from that path), `mv`s it to a `.prev` backup, `mv`s the staged file
   into its place, then execs that same path directly (there's no `open -n`/LaunchServices
   equivalent for a plain packaged Linux binary) and checks it's still alive with `pgrep -f`, same as
   macOS.

### Rolling out safely / rollback

Same conventions as macOS — publish to a scratch `METADATA_PATH` first, and roll back only by
publishing a newer version containing the older code (see above).
