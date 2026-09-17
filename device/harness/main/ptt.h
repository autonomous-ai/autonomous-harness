// Voice toggle on the physical BOOT button (GPIO0): press once to start recording, press again
// to stop; auto-stops after 30s. (GPIO0 doubles as factory-reset, but ONLY when held at
// power-on; during runtime it's the voice button.)
#pragma once

// Start the button poll task. Call after ui_set_voice().
void ptt_start(void);
