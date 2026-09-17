// The board this image is running on — decided at boot, not at build.
//
// Two dials ship at once. Same panel, audio, pins and firmware; they differ only in the touch
// controller, the reset pins and whether there is a PMIC (docs/plans/2026-09-15-004-two-boards-plan.md):
//
//                        touch              lcd/touch reset   PMIC (AXP2101 @0x34)   sleep key
//   "cst9217+axp2101"    CST9217 @0x5A      GPIO39 / GPIO40   yes: battery, PWR key   PWR tap, BOOT hold
//   "cst816s"            CST816S @0x15      GPIO1  / GPIO2    no                      BOOT hold
//
// Every one of those is a fact the I2C bus answers, so one image asks and configures itself — no SKU
// burned at the factory, no second OTA manifest, no image that can be flashed onto the wrong dial.
// Read per FEATURE, not per SKU: a batch that mixes them (CST816S with a PMIC, say) is right too.
#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum { TOUCH_NONE = 0, TOUCH_CST9217, TOUCH_CST816S } touch_chip_t;

typedef struct {
    const char  *name;          // goes up the cable in `hello.hw`, and into the boot log
    int          lcd_rst;       // CO5300 reset GPIO
    int          touch_rst;     // touch controller reset GPIO
    touch_chip_t touch;
    bool         touch_mirror;  // CST9217 is mounted 180° to the panel; CST816S reports panel-aligned
    bool         has_pmic;      // AXP2101 answered: battery figures + the PWR key exist
} board_t;

// Probe the bus and fill in the board. Call FIRST in app_main, before display_init() — the panel
// reset pin comes from here. Safe to call once; later calls return the same answer.
void board_detect(void);

// What board_detect found. Before it runs, the table for "cst9217+axp2101" (what the code assumed
// for its whole life until this file), so nothing dereferences a NULL.
const board_t *board(void);

// The decision itself, from the list of 7-bit addresses that ACKed. Pure — host-tested in
// test/test_board.c — so the table can be proved without a bus.
void board_from_acks(const uint8_t *acks, int n, board_t *out);

// One line, for the boot log and the daemon: "touch=cst816s pmic=no rst=1/2".
const char *board_describe(void);
