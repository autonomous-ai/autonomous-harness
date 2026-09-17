# Firmware release runbook

How a new device firmware reaches devices already in the field. Read this before cutting a release.

> TL;DR — you never touch the devices. You publish one build to a **public GCS bucket**; every device
> pulls it itself, straight from GCS, on its next boot or within ~6 h. The backend is not involved.

## 1. How updates reach devices (the pull model)

Nothing is pushed. Each device polls a **public GCS manifest** and self-updates:

```
device boot ─┐                         (also every ~6 h while running)
             ▼
   GET  https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/esp32/ota/metadata.json
             │      → { "commander": { version, url, sha256, size } }
             │
             ├─ metadata.commander.version == running esp_app_desc version ? ──► yes: do nothing (no-op)
             │
             ▼ no (newer version published)
   GET  <metadata.commander.url>   ──►  streamed straight into the INACTIVE OTA slot (ota_0 ⇄ ota_1)
             ▼
   SHA-256(written image) == metadata.commander.sha256 ?  ──►  no: abort, keep running old firmware
             ▼ yes
   set boot slot → reboot → run new firmware
             ▼
   on next healthy commander connect → mark image valid (cancel rollback)
```

The manifest URL + entry key are baked into the firmware: `DEVICE_OTA_METADATA_URL` and
`DEVICE_OTA_KEY` (`"commander"`) in `main/config_store.h`. TLS to `storage.googleapis.com` is verified
against the bundled CA roots (`esp_crt_bundle_attach`), so the download is authenticated end-to-end.

Relevant code: the boot + periodic check is `app_main.c` (`ota_check_and_apply()`, called at boot in
`refresh_task` and every ~6 h); fetch/parse of the manifest is `api_ota_metadata` in `main/http_api.c`;
the download / SHA-256 verify / commit logic is in `main/ota.c`; the "image is healthy, keep it"
confirmation fires on the commander `connected` frame (`commander_client.c`, `ota_mark_valid`). A build
that reboots but can **not** confirm within the boot is automatically rolled back by the bootloader
(`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`), so a broken update cannot brick a device.

Result: **no recall, no per-device action.** Publish once, the harness converges within one boot or ≤6 h.

## 2. Cutting a release

After editing the device code, one command does the rest (bump version → build → upload to GCS). From
the **repo root**:

```bash
make upload-circle                    # auto-bump the patch (0.1.2 -> 0.1.3), build, upload
make upload-circle ARGS="0.2.0"       # release an explicit version
make upload-circle ARGS="--no-build"  # upload the existing build/ artifact as-is
make upload-circle ARGS="--no-bump"   # keep version.txt as-is, build + upload
make upload-circle ARGS="--no-commit" # don't git-commit the version.txt bump
```

`make upload-circle` just runs `device/harness/scripts/upload-firmware.sh` (a full pipeline: bump
`version.txt` → `idf.py -C device/harness build` → upload `.bin` + merge `metadata.json` to GCS → **git
commit + push** the `version.txt` bump). You can call the script directly too. It auto-sources the ESP-IDF env
from `IDF_PATH` or `~/esp/esp-idf`; if a step fails before publishing, it reverts the `version.txt`
bump so a failed run leaves no dangling version.

**Publish prerequisites:** `gsutil` must be installed and authenticated (`gcloud auth login` /
service account) with write access to the bucket, and the bucket/objects must be **public-read** so
devices can download without credentials.

Notes:

- The version baked **into the binary** (`esp_app_desc.version`) and the version in the **manifest**
  both come from the same `device/harness/version.txt`, so the device's equality check is exact. Keep them
  in sync by only ever changing the version there.
- If a rebuild doesn't seem to pick up the new version, `touch device/harness/version.txt` before step 3
  to force the app-descriptor to regenerate.
- GCS layout (all overridable via env in `scripts/upload-firmware.sh`): bucket
  `s3-autonomous-upgrade-3`, binary `harness/esp32/bin/<version>.bin`, manifest
  `harness/esp32/ota/metadata.json`, key `commander`.
- The manifest is uploaded with `Cache-Control: no-cache` so devices always see the newest version.
- Devices apply the update on their next boot or within ~6 h — there is no instant push.

## 3. Field-provisioning requirement (for devices "out there")

OTA now targets a **hardcoded public GCS URL**, independent of the backend the device was provisioned
with. So any device with a working internet connection (able to reach `storage.googleapis.com` over
HTTPS) can update — even if it was provisioned with a LAN-only backend URL.

The only requirements for a field device to update are:

- a working WiFi connection with general internet access, and
- the GCS objects staying **public-read** (see §5).

(The provisioned backend URL still matters for pairing / commander / voice — just not for OTA.)

## 4. Halting or rolling back a bad release

- **Automatic:** if a shipped build boots but can't confirm itself healthy, the bootloader rolls back
  to the previous slot on the next reboot (`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`). No action needed
  for a build that fails to run.
- **Manual (a bad-but-runnable build):** re-publish a known-good build — rebuild from the good source
  and run `scripts/upload-firmware.sh` so the manifest again advertises the good version. Devices that
  haven't updated yet stay on the good version; devices that already took the bad build pick up the
  good one on their next check.
- Because the gate is an exact version-string compare, the "good" version you re-publish must
  **differ** from the bad one the devices are now running (bump to e.g. `0.1.3` → `0.1.4`), or they'll
  consider themselves up to date.

## 5. Flashing a published build over USB (operations)

When a board must be brought to a known version by hand — OTA is broken on it, it is being prepared
for someone, or a field unit came back — use the flasher instead of building anything:

```bash
curl -fsSL https://harness.autonomous.ai/flash-circle.sh -o flash-circle.sh
bash flash-circle.sh                 # newest published build
bash flash-circle.sh --detect-only   # just say what board is plugged in
bash flash-circle.sh --version 0.0.21
```

Requires only `curl`, `tar` and `bash`. If esptool is missing it **installs it itself** — a
standalone binary, checked against a sha256 the script carries, from our mirror when reachable and
otherwise straight from the vendor's release. So an operations laptop needs **no Python, no pip, no
ESP-IDF and no repo**. Developers can use `make flash-circle` from the repo instead — same script.

What it does, and why each step is there:

- **Verifies before writing.** The firmware is checked against the `sha256` published in
  `metadata.json`; a mismatch aborts before the board is touched. `--version X.Y.Z` bypasses the
  manifest and therefore cannot be authenticated — the tool says so out loud.
- **Finds the board and refuses the wrong one.** Every candidate serial port is probed with
  `chip_id`; only an **ESP32-S3** is accepted. That is what stops this image reaching the square board
  (ESP32-P4) or an unrelated USB device. Two boards plugged in ⇒ it asks for `--port` rather than guess.
- **Erases `otadata` first.** A board that has taken an OTA is running from `ota_1`; writing `ota_0`
  alone would change nothing it ever boots — the flash would "succeed" while the old firmware kept
  running. A blank `otadata` sends the bootloader back to `ota_0`, which is what was just written.
- **Keeps NVS.** The pairing token and saved WiFi live at `0x9000` and are never touched, so a flashed
  device does not have to be set up again. `--erase-nvs` opts into wiping them.
- **Confirms afterwards** by reading `App version:` from the boot log — what is *running*, not what we
  believe we sent.

**Scope:** this UPDATES a working board. The published artifact is the app image only (no bootloader,
no partition table), so a virgin board still needs one `idf.py flash` from the repo first.

### Shipping the flasher

⚠️ **THE FLASHER DID NOT MOVE WITH THE FIRMWARE.** It lives at
`apps/web/src/app/flash-circle.sh/flash-circle.sh` in **`autonomous-code`**, because the web app serves
it at `/flash-circle.sh` — exactly like `/cli/install.sh` — and the web app stayed there. It therefore
still goes live with a **web deploy**, with no separate publish step to forget, and `no-cache` so an
operator can never be handed a stale flasher.

That split is worth knowing before you go looking: the thing that PUTS firmware on a virgin board is
in a different repo from the firmware itself, and `make flash-circle` only exists over there.

`make mirror-esptool` (also in `autonomous-code`) is optional: the flasher already installs a **pinned** esptool from the vendor
by itself. Mirroring only helps laptops on networks that block that download, and it prints the
sha256 block to paste back into `esptool_pinned_sha()` when `ESPTOOL_VERSION` is bumped. It does not
touch `metadata.json`.

## 6. Production hardening — TODO before public shipment

The OTA path is now HTTPS (CA-verified) + SHA-256 over a public bucket. Remaining items before
shipping to real users:

- **Keep the bucket public-read but write-locked.** Anyone can read the firmware (fine — it's not
  secret and the device verifies the cert + SHA-256), but only the release identity should have write
  access. Never expose write credentials in the firmware or client code.
- **Image signing (Secure Boot v2).** SHA-256 proves integrity, not authenticity: a party who can
  write to the bucket could publish their own valid-SHA image. Add app signing so only your-signed
  firmware boots. (TLS already prevents a network MITM from altering the download in flight.)
- **Staged rollout.** There is a single global "latest" per key — every device updates at once, so a
  bad release hits the whole harness. For large harnesses, add canary / percentage gating before making a
  new version the advertised latest.
