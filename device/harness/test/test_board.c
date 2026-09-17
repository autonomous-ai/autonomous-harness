// The board decision table, proved without a bus. See main/board/board_table.c.
#include <stdio.h>
#include <string.h>
#include "../main/board/board.h"

static int fails;
#define CHECK(cond) do { if (!(cond)) { fails++; printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); } } while (0)

static board_t decide(const uint8_t *acks, int n) { board_t b; memset(&b, 0, sizeof b); board_from_acks(acks, n, &b); return b; }

int main(void)
{
    // Board A, as measured: AXP2101 + CST9217 (+ the codecs, which the decision ignores).
    board_t a = decide((const uint8_t[]){ 0x34, 0x5A, 0x18, 0x40 }, 4);
    CHECK(a.touch == TOUCH_CST9217); CHECK(a.touch_mirror); CHECK(a.has_pmic);
    CHECK(a.lcd_rst == 39 && a.touch_rst == 40); CHECK(!strcmp(a.name, "cst9217+axp2101"));

    // Board B, as measured: CST816S alone.
    board_t b = decide((const uint8_t[]){ 0x15, 0x18, 0x40 }, 3);
    CHECK(b.touch == TOUCH_CST816S); CHECK(!b.touch_mirror); CHECK(!b.has_pmic);
    CHECK(b.lcd_rst == 1 && b.touch_rst == 2); CHECK(!strcmp(b.name, "cst816s"));

    // A batch that mixes them: the reset pins follow the touch chip, the PMIC is its own fact.
    board_t mix = decide((const uint8_t[]){ 0x15, 0x34 }, 2);
    CHECK(mix.touch == TOUCH_CST816S && mix.has_pmic && mix.lcd_rst == 1);
    CHECK(!strcmp(mix.name, "cst816s+axp2101"));

    // Nothing answered: board A's shape, no touch, no PMIC — the UI still has to come up.
    board_t none = decide(NULL, 0);
    CHECK(none.touch == TOUCH_NONE && !none.has_pmic && none.lcd_rst == 39);
    CHECK(!strcmp(none.name, "notouch"));

    // Both touch chips answering is not a board that exists; CST9217's pins win (board A's shape).
    board_t both = decide((const uint8_t[]){ 0x5A, 0x15 }, 2);
    CHECK(both.touch == TOUCH_CST9217 && both.lcd_rst == 39);

    printf("board: %s\n", fails ? "FAILED" : "ok");
    return fails ? 1 : 0;
}
