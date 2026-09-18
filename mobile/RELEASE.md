# Releasing the iOS app

The App Store record is **Autonomous Harness** (`ai.autonomous.harness.ios`, team 54DJVWMJCC —
Autonomous Inc.). Everything below is the iOS side only; the desktop app ships from
`desktop/RELEASE.md` on its own tags and shares nothing with this.

## The two numbers that decide whether an upload is visible at all

App Store Connect keys a build on the pair `(CFBundleShortVersionString, CFBundleVersion)` — in
`pubspec.yaml` that is `version: 1.0.0+2`, so `1.0.0` and `2`.

- **Bump the `+N` before every upload.** A pair ASC has already seen is refused, and the refusal
  arrives *by email* — the ASC UI shows nothing at all, which is exactly what "I uploaded it and
  nothing happened" looks like.
- **The short version must match the ASC version record.** A build uploaded as `1.0.0` never appears
  under a version record called `1.0`: the Build section stays empty and the version cannot be
  submitted. Rename one so the two strings are identical.

## Upload

One command. Credentials are already on the release Mac, so there is nothing to export:

```bash
bash mobile/scripts/release-ios.sh                 # build -> validate -> upload
bash mobile/scripts/release-ios.sh --validate-only # rehearse, upload nothing
bash mobile/scripts/release-ios.sh --skip-build    # upload the ipa already in build/ios/ipa
```

### Where the credentials live, and why not here

```
~/.appstoreconnect/harness-release.env          ASC_KEY_ID + ASC_ISSUER_ID   (chmod 600)
~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8   the private key    (chmod 600)
```

The script sources that `.env` whenever the environment does not already carry the values, so CI can
still pass them in. **They are deliberately not written into this file.** This repo is public, and a
Key ID plus an Issuer ID are precisely the two halves a leaked `.p8` would need to become a working
App Store Connect session — the repo's own `.gitignore` already refuses `*.p8` and `.env*`, and
putting the other halves in Markdown would walk straight around that.

Setting up a second machine: create a Team Key at App Store Connect ▸ Users and Access ▸ Integrations
▸ App Store Connect API (role App Manager), drop the one-time `.p8` download into
`~/.appstoreconnect/private_keys/`, and write the two ids into the `.env` above. An Apple ID plus an
**app-specific** password (`ASC_USERNAME` / `ASC_APP_PASSWORD`) works too.

The script validates before uploading, which is what catches a duplicate build number or a missing
icon size in thirty seconds instead of in an email twenty minutes later.

### Already uploaded

| Build | When | Where it went |
| --- | --- | --- |
| `1.0.0 (2)` | 2026-09-16 | TestFlight. Universal (iPhone + iPad) — superseded |
| `1.0.0 (3)` | 2026-09-16 | TestFlight. **iPhone only** |
| `1.0.0 (4)` | 2026-09-16 | TestFlight. Adds agent/machine search (`feat/mobile-search`) |
| `1.0.0 (5)` | 2026-09-16 | TestFlight. Agent creation flow; Machines tab pairs/unpairs |
| `1.0.0 (6)` | 2026-09-16 | TestFlight. Custom voice input on a terminal tap — misheard Vietnamese, removed for the keyboard's own dictation |
| `1.0.0 (7)` | 2026-09-17 | TestFlight. Voice input back, transcribed by the backend (`/api/voice/stt`); opens on the last agent's terminal |
| `1.0.0 (8)` | 2026-09-17 | TestFlight. Search grouped by folder, most recent first, one-bar field; keyboard only from a tap on the prompt; hold-to-talk mic; slimmer terminal chrome |
| `1.0.0 (9)` | 2026-09-17 | TestFlight. Terminal chrome rebuilt around a search bar, header folds away on scroll, ⋯ sheet grouped into Agent / Machines / App |
| `1.0.0 (10)` | 2026-09-17 | TestFlight. Smoother swipes and scrolling: parked and keyboard-sliding terminals keep painting; the header folds over the terminal instead of resizing it |
| `1.0.0 (11)` | 2026-09-17 | TestFlight. Agents either side of the one on screen open in advance, so a swipe lands on output instead of "Attaching…" |
| `1.0.0 (12)` | 2026-09-18 | TestFlight. Named OpenHarness on the home screen and in the app; Backspace on the phone erases text typed on the desktop; Machines moved into the ⋯ sheet; hold-to-talk hardened |
| `1.0.0 (13)` | 2026-09-18 | TestFlight. Search reads what agents said (the desktop's content index), recent first; Vietnamese Telex in the search field; terminal search has no Cancel, and the terminal holds still as it closes |

`pubspec.yaml` is therefore at `1.0.0+14`: the repo always holds the NEXT build number, so a release
runs clean without anyone having to remember the last one.

### Why the app is iPhone-only

`TARGETED_DEVICE_FAMILY = 1`. It was `"1,2"` — Flutter's default — and App Store Connect answers a
universal binary by requiring a 13-inch iPad screenshot set on top of the iPhone one, which is what
blocked *Add for Review*.

⚠️ The iPad LAYOUT still exists and is still reached by the shortest-side breakpoint in
`lib/phone/phone_layout.dart` ("an iPad keeps the rail beside its terminals"). Nothing about it was
deleted; it simply is not shipped to iPad any more. Putting iPad back is one line here plus a 13-inch
screenshot set — and a new build, since the requirement follows the BUILD selected on the version,
not the app record.

Uploading is not submitting. Processing takes 5–30 minutes, then the build becomes selectable in the
version's **Build** section.

## Metadata — what goes in each field

Fill these on *Distribution ▸ iOS App 1.0.0*. Apple will not accept the version while Description,
Privacy Policy URL, App Privacy, age rating or pricing are blank.

**Subtitle** (30 max)

```
Your coding agents, anywhere
```

**Promotional Text** (170 max — editable later without a new build)

```
Attach to the coding agents already running on your machines. Same panes, same scrollback, end-to-end encrypted — now from your phone.
```

**Description**

```
Harness puts the coding agents running on your own computers in your pocket.

Claude Code, Codex, Cursor and a dozen others already run on your Mac or Linux box. Harness keeps
each one in a live session on the machine it runs on, and this app attaches to those sessions from
your phone — the same panes, the same scrollback, exactly where you left them.

WHAT YOU CAN DO
• Read what an agent is doing right now, from anywhere
• Type back: answer a prompt, approve a step, send a new instruction
• Send a photo or screenshot straight into a session
• Switch between machines and between agents in one list
• Rename, restart or delete an agent without opening your laptop

HOW IT WORKS
Sessions live on your machine, not in this app and not on a server. Closing the app, losing signal or
switching devices changes nothing about what the agent is doing — you reattach and the work is where
it was.

Everything between your phone and your machine is end-to-end encrypted. Where the network allows it
the connection is peer-to-peer; where it does not, the relay carries ciphertext it cannot read.

WHAT YOU NEED
• An Autonomous account
• At least one Mac or Linux machine running the free Harness CLI, paired to that account

Harness for iPhone is a companion to that setup, not a standalone editor or a general-purpose SSH
client. Without a paired machine there is nothing for it to attach to.
```

**Keywords** (100 max, commas, no spaces)

```
terminal,tmux,ssh,claude,codex,cursor,coding,agent,developer,remote,shell,devops,pair,session
```

**URLs**

| Field | Value |
| --- | --- |
| Support URL | `https://www.autonomous.ai/harness` |
| Marketing URL | `https://www.autonomous.ai/harness` |
| Privacy Policy URL | **required — use the real Autonomous policy URL; there is none in this repo to copy** |

**What's New** — leave empty for 1.0.0; it is only shown for updates.

## App Privacy

Answer these from what the code actually does, not from habit. The app has **no third-party SDK**:
analytics go to Autonomous's own `event_tracking` endpoint (`lib/analytics/`), and crash records are
written to a local `errors.log` and never leave the device (`lib/core/crash_log.dart`).

| Data type | Collected | Linked to the user | Purpose |
| --- | --- | --- | --- |
| Contact Info ▸ Email Address | Yes | Yes | App Functionality, Analytics |
| Identifiers ▸ User ID | Yes | Yes | App Functionality, Analytics |
| Usage Data ▸ Product Interaction | Yes | Yes | Analytics |
| Diagnostics | No | — | crash log stays on device |

**Tracking: No.** Nothing here follows a person across other companies' apps or goes to a data
broker, so the app needs no App Tracking Transparency prompt.

Terminal contents are deliberately outside all of this: `Analytics.track`'s contract forbids message
text, prompts, terminal output, file contents and absolute paths, and the session bytes themselves
are end-to-end encrypted.

## App Review notes — the part that gets 1.0 rejected

A reviewer opens this app, signs in, and sees **no machines**, because they have none running the
CLI. That reads as a broken or incomplete app (Guideline 2.1) and it is the single most likely reason
this version comes back. So:

1. Create a demo account and put it in **App Review Information ▸ Sign-In Required**.
2. Leave a real machine online, paired to that account, for the length of the review — a reviewer who
   can attach to a live agent cannot mistake the app for an empty shell.
3. Paste notes along these lines:

```
Harness is a companion app for developer agents running on the user's own computers.

Demo account: <email> / <password>
A Mac paired to this account is kept online for the review, so the Agents tab will list live
sessions. Tap one to attach to its terminal, read the output and type into it.

The app does not run any agent itself: it attaches over an end-to-end encrypted channel to sessions
owned by the user's own machine, which is why an account with no paired machine shows an empty list.

The camera permission is used only when sending a photo into a session (Agents ▸ a session ▸ the
image button).

The microphone permission is used only for voice input: the mic button under a session's terminal
records what is said, and it is transcribed into the message sent to that session (a session ▸ the
mic at the bottom right).
```

## Submitting

1. **Build** section ▸ `+` ▸ pick the build you uploaded.
2. Fill everything above, plus age rating and *Pricing and Availability*.
3. **Add for Review** ▸ **Submit for Review**.
4. Watch for **Pending Developer Release** after approval — approved is not released; that state
   waits on a button of yours, forever if you let it.

## Open risk — export compliance

`ios/Runner/Info.plist` declares `ITSAppUsesNonExemptEncryption = false`, which auto-answers the
export question and is right only for an app whose encryption is the OS's own HTTPS. This app
terminates its own end-to-end encryption (X25519, ChaCha20-Poly1305, a CPace PAKE — `lib/e2ee/`), so
that answer is very likely wrong. Settle it with whoever owns export compliance before submitting: a
wrong answer is not a build failure, it is review asking a question and the version standing still
until someone answers it.
