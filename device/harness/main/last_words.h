// The last log lines before a reset, and the reason for it.
//
// A dial that panics, trips a watchdog or browns out reboots in under a second and greets the daemon as
// if nothing happened — from the desk it looks like an unplug. This keeps a small ring of the most recent
// log lines in RTC memory that survives a soft reset, and on the next boot, if the reset was not a clean
// one, replays them over the cable once a daemon is listening.
#pragma once

#include <stdbool.h>
#include <stddef.h>

// At boot, before anything logs: read the reset reason, keep the previous boot's ring if the reset was
// abnormal, then arm the ring for this boot.
void last_words_boot(void);

// Append one formatted log line. Called from the log sink; cheap, spinlocked, never blocks.
void last_words_add(const char *line, size_t len);

// Once a daemon is listening (session up): log the reset reason, and the previous boot's last lines if
// that reset was a crash. Logs once per boot.
void last_words_report(void);
