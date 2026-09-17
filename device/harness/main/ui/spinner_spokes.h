#pragma once
#include "lvgl.h"
// 12 pre-rotated spinner bars (30 degrees apart), 18x18, white with alpha. See the .c for why they are
// baked rather than rotated at runtime.
#define SPINNER_SPOKE_PX 18
extern const lv_image_dsc_t *const spinner_spokes[12];
