#!/usr/bin/env python3
"""Generate the shared framing vectors for the USB cable link.

    device/harness/scripts/gen_cable_vectors.py        # writes test/vectors/cable_frame.txt
    device/harness/scripts/gen_cable_vectors.py --check # fails if the file on disk differs

A THIRD implementation, written from the format description in main/cable_frame.h and from nothing
else. That is the entire point: the firmware (C) and the daemon (TypeScript, in the autonomous-harness
repository) each assert against this file, so a misreading shared by both halves shows up as a
disagreement with the vectors instead of being blessed by two implementations that copied each other.
The two halves live in different repositories and cannot import a line of code between them.

Format, tab-separated, `#` comments and blank lines ignored:

    encode  <name>  <type>  <payload-hex>  <frame-hex>
    stream  <name>  <input-hex>  <frames>  <discarded>  <corrupt>

`frames` is a comma-separated list of `type:payload-hex`, or `-` for none. `discarded` and `corrupt`
are the decoder counters after feeding the whole input. The stream cases are the valuable half: encoding
is arithmetic both sides get right, while resync after noise is where two readers actually diverge.
"""

import argparse
import pathlib
import sys

# Product-scoped: 0x48 is 'H' for Harness. See main/cable_frame.h for why the second byte names the
# product — these vectors are no longer shared with the sibling product, and must not be.
MAGIC = b"\xa5\x48"
VERSION = 1
MAX_PAYLOAD = 8192
HEADER_BYTES = 6

TYPE_JSON, TYPE_PCM, TYPE_FW, TYPE_LOG = 1, 2, 3, 4


def crc16(data: bytes) -> int:
    """CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def frame(type_: int, payload: bytes) -> bytes:
    """One frame per the description. The CRC covers ver..payload — the magic is a marker, not data."""
    assert len(payload) <= MAX_PAYLOAD, "payload over the cap is a bug on the sending side"
    head = bytes([VERSION, type_, len(payload) & 0xFF, (len(payload) >> 8) & 0xFF])
    body = head + payload
    return MAGIC + body + crc16(body).to_bytes(2, "little")


def ramp(n: int) -> bytes:
    """Deterministic filler that is not all one byte — a run of zeros hides index bugs."""
    return bytes(((i * 7) + 13) & 0xFF for i in range(n))


def encode_cases():
    """(name, type, payload) — every one also becomes a single-frame stream case below."""
    return [
        ("json_empty_object", TYPE_JSON, b"{}"),
        ("json_hello", TYPE_JSON, b'{"t":"hello","proto":1}'),
        # Vietnamese text, as the voice language row and every agent name can carry.
        ("json_utf8", TYPE_JSON, '{"t":"note","v":"đã xong"}'.encode()),
        # The payload contains the magic. A reader that scans for magic without honouring the length
        # field resyncs into the middle of its own frame here.
        ("json_payload_holds_magic", TYPE_JSON, b'{"t":"x","v":"\xa5\x5a\xa5\x5a"}'),
        ("pcm_zero_length", TYPE_PCM, b""),
        ("pcm_eight_bytes", TYPE_PCM, bytes([0x00, 0xFF, 0x7F, 0x80, 0x01, 0xFE, 0xA5, 0x5A])),
        ("pcm_chunk_1024", TYPE_PCM, ramp(1024)),
        ("fw_slice_max", TYPE_FW, ramp(MAX_PAYLOAD)),
        ("log_line", TYPE_LOG, b"I (1234) cable: link up"),
        # Not a type this build knows. Kept as a vector because the rule is that an unknown type is
        # handed up with its raw byte rather than dropped — a newer peer must read as a mismatch.
        ("unknown_type_0x7f", 0x7F, b"whatever"),
    ]


def stream_cases():
    """(name, input bytes, [(type, payload)], discarded, corrupt) — decoder behaviour, byte for byte."""
    hello = frame(TYPE_JSON, b'{"t":"hello"}')
    pong = frame(TYPE_JSON, b'{"t":"pong"}')
    pcm = frame(TYPE_PCM, ramp(64))
    cases = []

    for name, type_, payload in encode_cases():
        cases.append((f"single_{name}", frame(type_, payload), [(type_, payload)], 0, 0))

    cases.append(("back_to_back", hello + pong + pcm,
                  [(TYPE_JSON, b'{"t":"hello"}'), (TYPE_JSON, b'{"t":"pong"}'), (TYPE_PCM, ramp(64))],
                  0, 0))

    # The boot case this framing exists for: the ROM and the second-stage bootloader print plain text to
    # the one USB port this board has, so the reader walks into the middle of a stream at every boot.
    boot = b"ESP-ROM:esp32s3-20210327\r\nBuild:Mar 27 2021\r\n"
    cases.append(("leading_boot_text", boot + hello, [(TYPE_JSON, b'{"t":"hello"}')], len(boot), 0))

    # A lone A5 must be kept: the 5A may simply not have arrived yet. Here it never does, and the byte is
    # only discarded once something else proves it was not a header.
    cases.append(("trailing_lone_magic0", hello + b"\xa5", [(TYPE_JSON, b'{"t":"hello"}')], 0, 0))

    # Corrupt CRC: exactly ONE byte is discarded per attempt, not the whole candidate — the magic may
    # have been a coincidence inside noise and a real frame can begin one byte further in. That is what
    # lets the good frame behind it still arrive.
    bad = bytearray(hello)
    bad[-1] ^= 0xFF
    # ALL of the bad frame is discarded, but in two steps that matter separately: one byte to step past
    # the magic that turned out not to open a frame, then the remaining bytes as noise once the scan
    # finds no other magic in them. The count is the whole frame either way — what is being asserted is
    # that the GOOD frame behind it still arrives, which a decoder that drops the candidate whole would
    # also pass, and that nothing beyond it was eaten, which such a decoder would not.
    cases.append(("bad_crc_then_good", bytes(bad) + pong,
                  [(TYPE_JSON, b'{"t":"pong"}')], len(bad), 1))

    # A length field that cannot be real means those two bytes were noise, not a header. Waiting for
    # 64 KB that is never coming would stall the link, so the reader steps over one byte and hunts on.
    huge = MAGIC + bytes([VERSION, TYPE_JSON, 0xFF, 0xFF]) + b"\x00\x00"
    cases.append(("oversized_length_then_good", huge + pong,
                  [(TYPE_JSON, b'{"t":"pong"}')], len(huge), 0))

    # Two frames whose magic pair straddles the join between two reads. The decoder is fed the whole
    # buffer here; the C and TS tests additionally replay every stream case one byte at a time, which is
    # what actually exercises the split.
    cases.append(("magic_split_across_reads", hello + pcm,
                  [(TYPE_JSON, b'{"t":"hello"}'), (TYPE_PCM, ramp(64))], 0, 0))

    # Noise that happens to contain the magic, inside a frame's payload region, followed by a real frame.
    noise = b"\xa5\x5a\x99\x99\x99\x99"
    cases.append(("magic_shaped_noise", noise + pong, [(TYPE_JSON, b'{"t":"pong"}')], len(noise), 0))

    return cases


def render() -> str:
    out = [
        "# Shared framing vectors for the harness USB cable link.",
        "# Generated by device/harness/scripts/gen_cable_vectors.py — a third implementation, written",
        "# from main/cable_frame.h's format description and from neither half's code. Do not hand-edit.",
        "#",
        "#   encode  <name>  <type>  <payload-hex>  <frame-hex>",
        "#   stream  <name>  <input-hex>  <type:payload-hex,...|->  <discarded>  <corrupt>",
        "#",
        f"# CRC-16/CCITT-FALSE check value for \"123456789\" = 0x{crc16(b'123456789'):04X} (asserted at generation).",
        "",
    ]
    for name, type_, payload in encode_cases():
        out.append(f"encode\t{name}\t{type_}\t{payload.hex()}\t{frame(type_, payload).hex()}")
    out.append("")
    for name, data, frames, discarded, corrupt in stream_cases():
        rendered = ",".join(f"{t}:{p.hex()}" for t, p in frames) or "-"
        out.append(f"stream\t{name}\t{data.hex()}\t{rendered}\t{discarded}\t{corrupt}")
    out.append("")
    return "\n".join(out)


def main() -> int:
    assert crc16(b"123456789") == 0x29B1, "not CRC-16/CCITT-FALSE — the whole file would be wrong"

    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if the file on disk differs from what this run would write")
    args = ap.parse_args()

    path = pathlib.Path(__file__).resolve().parent.parent / "test" / "vectors" / "cable_frame.txt"
    text = render()
    if args.check:
        if not path.exists():
            print(f"missing: {path}", file=sys.stderr)
            return 1
        if path.read_text() != text:
            print(f"stale: {path} — re-run {pathlib.Path(__file__).name}", file=sys.stderr)
            return 1
        print(f"up to date: {path}")
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    print(f"wrote {path} ({len(text.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
