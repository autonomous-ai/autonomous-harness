#!/usr/bin/env python3
"""Regenerate device product-mark LVGL maps from the web's vendored engine icons."""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from PIL import Image, ImageOps


REPO_ROOT = Path(__file__).resolve().parents[3]

# THE ICONS ARE NOT IN THIS REPO. They are vendored by the web app, which stayed
# behind in `autonomous-code` when the firmware moved here — so this tool needs
# to be pointed at a checkout of it:
#
#   HARNESS_ENGINE_ICONS=~/src/autonomous-code/apps/web/public/engine-icons \
#     python3 device/harness/tools/generate_engine_icons.py
#
# The SHA-256 table below is what makes that safe to do across two repos: an icon
# that has changed on the web side fails the check rather than silently
# regenerating the device's marks from art nobody compared.
ASSET_DIR = Path(
    os.environ.get("HARNESS_ENGINE_ICONS")
    or REPO_ROOT / "../autonomous-code/apps/web/public/engine-icons"
).expanduser()
TARGET = REPO_ROOT / "device/harness/main/ui/icons_engine.c"
ICON_SIZE = 20
EXPECTED_SHA256 = {
    "codex.png": "8e82b26c98a10e45798ce48124515720657f7735fb8d0853b3f087eaa8a6b74e",
    "cursor.png": "2e9f8c157ce6ef7a57c2c6ac451033035779ab07b142b7313ec5d301f5489802",
    "opencode.png": "44d24a1c9e7e2af1f6551bd808b1330e2493e233a173c5930b300b70290e1b57",
    "pi.png": "b158ff280646a073c163e8cfc71b85cec40b6f89e7a47dd99a5b7838eb86081c",
    "hermes.png": "0cad9cd8f57639ffd60fe1ff2e6cb722bca4fc1bf8e9137068dba4b2f3abc989",
    "commandcode.png": "0c81f1fea24a52e38e12cba2b4a79563a251124414ab8ef065eee8f02480e554",
    "devin.png": "553815811d5fa3586672b2ba2f04d61de49bec786d7f71ad4ba5d011aae825ca",
    "muse.png": "d7c4568f992e60f6d42a7a819a5a782d479cbfd9ad2bc11e69c82b35b8a5d8fe",
    "amp.png": "e5fc0d1178674b80c0dcbbf9811787b44df91f865fac9cd3ef44bb13ef728018",
    "kilo.png": "03a348a04c622938a278d803cbb6333819de855d2b3127de8e412fd261db3701",
    "grok.png": "56357e60b43284734c58e06596be038c58d7fd1a9bea7325d21a107a44ea4b47",
    "copilot.png": "74d0d5240665d55d29b73863c1c0ed52aad934e5b388117c63d69bcc805e474f",
    "agy.png": "8f0b95d2d21dbf930b4d100e2fdc4505673e900a731aa56ea633a4b59c312799",
}


def lvgl_argb8888(path: Path) -> list[int]:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != EXPECTED_SHA256[path.name]:
        raise RuntimeError(f"{path} has unexpected SHA-256 {digest}; update its provenance before regenerating")

    source = Image.open(path).convert("RGBA")
    fitted = ImageOps.contain(source, (ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(
        fitted,
        ((ICON_SIZE - fitted.width) // 2, (ICON_SIZE - fitted.height) // 2),
    )

    # LVGL's ARGB8888 data is laid out as B, G, R, A bytes on the ESP32 target.
    result: list[int] = []
    for red, green, blue, alpha in canvas.get_flattened_data():
        result.extend((blue, green, red, alpha))
    return result


def c_array(name: str, values: list[int]) -> str:
    rows = []
    for offset in range(0, len(values), 32):
        rows.append("    " + ",".join(str(value) for value in values[offset : offset + 32]) + ",")
    return f"static const uint8_t {name}[] = {{\n" + "\n".join(rows) + "\n};"


def replace_array(source: str, name: str, values: list[int]) -> str:
    pattern = rf"static const uint8_t {re.escape(name)}\[\] = \{{.*?\n?\}};"
    replacement = c_array(name, values)
    updated, count = re.subn(pattern, replacement, source, count=1, flags=re.DOTALL)
    if count != 1:
        raise RuntimeError(f"Expected one {name} array in {TARGET}, found {count}")
    return updated


def main() -> None:
    source = TARGET.read_text()
    source = replace_array(source, "icon_codex_map", lvgl_argb8888(ASSET_DIR / "codex.png"))
    source = replace_array(source, "icon_cursor_map", lvgl_argb8888(ASSET_DIR / "cursor.png"))
    source = replace_array(source, "icon_opencode_map", lvgl_argb8888(ASSET_DIR / "opencode.png"))
    source = replace_array(source, "icon_pi_map", lvgl_argb8888(ASSET_DIR / "pi.png"))
    source = replace_array(source, "icon_hermes_map", lvgl_argb8888(ASSET_DIR / "hermes.png"))
    source = replace_array(source, "icon_commandcode_map", lvgl_argb8888(ASSET_DIR / "commandcode.png"))
    source = replace_array(source, "icon_devin_map", lvgl_argb8888(ASSET_DIR / "devin.png"))
    source = replace_array(source, "icon_muse_map", lvgl_argb8888(ASSET_DIR / "muse.png"))
    source = replace_array(source, "icon_amp_map", lvgl_argb8888(ASSET_DIR / "amp.png"))
    source = replace_array(source, "icon_kilo_map", lvgl_argb8888(ASSET_DIR / "kilo.png"))
    source = replace_array(source, "icon_grok_map", lvgl_argb8888(ASSET_DIR / "grok.png"))
    source = replace_array(source, "icon_agy_map", lvgl_argb8888(ASSET_DIR / "agy.png"))
    source = replace_array(source, "icon_copilot_map", lvgl_argb8888(ASSET_DIR / "copilot.png"))
    TARGET.write_text(source)


if __name__ == "__main__":
    main()
