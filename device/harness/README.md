# OpenHarness device firmware

A round USB companion for your agents. See their progress, read and answer questions, and speak a
task from the device on your desk. This is the open-source ESP32-S3 firmware; you can build it,
flash a supported board, or contribute a hardware port.

**The connection is USB.** The host computer runs the Harness daemon and sends the agent state over
the cable. The current firmware has no Wi-Fi setup, backend connection, account credentials, or
pairing code. Plugging the device into the host establishes the connection.

Schematics and enclosure designs are coming; they are not included in this repository yet.

## Supported hardware

The current board family is the Waveshare ESP32-S3-Touch-AMOLED-1.75C: an ESP32-S3 with a 466 × 466
CO5300 AMOLED display, touch, microphones, and audio output. The firmware detects two touch/board
variants on the I²C bus:

| Variant | Touch | Power management | Display / touch reset pins |
|---|---|---|---|
| Original board | CST9217 | AXP2101 | GPIO 39 / 40 |
| Compatible DXQ0175Y003 module | CST816S | No AXP2101 on the tested board | GPIO 1 / 2 |

The detected hardware, rather than a separate firmware build, selects the drivers and pins.
See [`main/board/`](main/board/) for the detection table and [`main/board/board_pins.h`](main/board/board_pins.h)
for the shared pin definitions. Other ESP32 boards need a port; matching the MCU alone is not enough.

## Build and flash your board

Install and activate ESP-IDF 5.5 or newer. From the repository root:

```bash
cd device/harness
idf.py set-target esp32s3
idf.py build
idf.py -p PORT flash monitor
```

Replace `PORT` with your board's serial port, for example `/dev/cu.usbmodem1101` on macOS.
Only one process can own the serial port: stop the daemon's device connection before using
`idf.py flash monitor`, and exit the monitor before reconnecting through the app. The normal app
flasher coordinates the serial-port handoff for you.

`sdkconfig.defaults` contains the build defaults. `sdkconfig` and the `build/` directory are
local generated files. After flashing, connect the board to a computer running the Harness daemon.
Firmware updates also travel through the host over USB; older descriptions of Wi-Fi provisioning
and device-initiated OTA downloads do not apply to this firmware.

## Contribute a hardware port

Start with the board detection and pin definitions. Include the board model, the observed I²C
addresses, and the display, touch, audio, and power-management behavior you tested. A photo or a
short recording helps someone with the same board reproduce the result.

The host-side checks do not require a physical board. From the repository root:

```bash
make device-test
```

Then test the actual device: boot, display, touch, USB reconnection, questions, audio, and firmware
update recovery. Report the hardware checks separately from the host tests.

The firmware is covered by the repository's [MIT license](../../LICENSE). Third-party components
retain their own licenses. See the [contribution guide](../../CONTRIBUTING.md) to get involved.
