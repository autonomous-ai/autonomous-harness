// See board_probe.c. Only compiled with -DBOARD_PROBE=1; app_main calls it before display_init().
#pragma once
void board_probe_run(void);
