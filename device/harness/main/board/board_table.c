// The decision table behind board_detect(): from "who answered on the bus" to pins and drivers.
// No ESP-IDF here on purpose — test/test_board.c compiles this file with a plain cc.
#include "board.h"

#include <stdbool.h>
#include <stdio.h>

// Measured, not assumed (2026-09-15, both units on the desk):
//   board A  ack 34 5A 18 40   (AXP2101, CST9217, ES8311, ES7210)
//   board B  ack 15 18 40      (CST816S, ES8311, ES7210)      — same before and after any reset pulse
#define ADDR_AXP2101  0x34
#define ADDR_CST9217  0x5A
#define ADDR_CST816S  0x15

static bool acked(const uint8_t *acks, int n, uint8_t addr)
{
    for (int i = 0; i < n; i++) if (acks[i] == addr) return true;
    return false;
}

void board_from_acks(const uint8_t *acks, int n, board_t *out)
{
    const bool pmic    = acked(acks, n, ADDR_AXP2101);
    const bool cst9217 = acked(acks, n, ADDR_CST9217);
    const bool cst816s = acked(acks, n, ADDR_CST816S);

    // The reset pins follow the TOUCH CHIP: the CST816S module (DXQ0175Y003) is the one wired to
    // GPIO1/2, whatever else is on the board. A dial with no touch answering at all is treated as
    // board A — the shape this code was written for, and the PMIC (if any) says so too.
    if (cst816s && !cst9217) {
        out->lcd_rst = 1;  out->touch_rst = 2;
        out->touch = TOUCH_CST816S; out->touch_mirror = false;
    } else {
        out->lcd_rst = 39; out->touch_rst = 40;
        out->touch = cst9217 ? TOUCH_CST9217 : TOUCH_NONE;
        out->touch_mirror = true;
    }
    out->has_pmic = pmic;
    out->name = out->touch == TOUCH_CST816S ? (pmic ? "cst816s+axp2101" : "cst816s")
              : out->touch == TOUCH_CST9217 ? (pmic ? "cst9217+axp2101" : "cst9217")
              : (pmic ? "notouch+axp2101" : "notouch");
}
