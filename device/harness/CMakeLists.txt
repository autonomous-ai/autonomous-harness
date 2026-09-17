# Top-level ESP-IDF project file for the Interns commander device.
#
# Board: Waveshare ESP32-S3-Touch-AMOLED-1.75C (ESP32-S3R8, 466x466 AMOLED CO5300).
# Requires ESP-IDF >= 5.5. Build with:  idf.py set-target esp32s3 && idf.py build
cmake_minimum_required(VERSION 3.16)

# ── Keep sdkconfig honest about sdkconfig.defaults ───────────────────────────────────────────────────
# ESP-IDF reads sdkconfig.defaults ONLY when creating sdkconfig. After that sdkconfig is authoritative and
# defaults are ignored outright — no merge, no warning. That is deliberate (so `idf.py menuconfig` edits
# survive), but it means the file we track states the intent while the file we gitignore decides the build.
#
# On 2026-07-30 that cost two weeks: commit 1f6c5be (2026-07-16) raised ESP_MAIN_TASK_STACK_SIZE to 10240,
# moved BSS to PSRAM and re-shaped the LVGL pool, but every build on a checkout whose sdkconfig predated it
# silently kept the old values. It surfaced as a broken build (a new font was referenced) and, worse, as
# published firmware that overflowed the main stack mid-OTA and could never update itself.
#
# So: stamp the hash of sdkconfig.defaults beside sdkconfig. When they disagree, delete sdkconfig and let
# IDF re-seed it. Day-to-day menuconfig still works; a pull that changes defaults re-applies automatically.
# A deliberate local tweak belongs in sdkconfig.defaults, where it is reviewable and reaches everyone.
set(_sdkcfg "${CMAKE_CURRENT_LIST_DIR}/sdkconfig")
set(_defaults "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults")
set(_stamp "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults.stamp")
if(EXISTS "${_defaults}")
    file(SHA256 "${_defaults}" _defaults_hash)
    set(_prev_hash "")
    if(EXISTS "${_stamp}")
        file(READ "${_stamp}" _prev_hash)
        string(STRIP "${_prev_hash}" _prev_hash)
    endif()
    if(EXISTS "${_sdkcfg}" AND NOT _prev_hash STREQUAL _defaults_hash)
        message(WARNING
            "sdkconfig.defaults changed since this sdkconfig was generated -- regenerating it.\n"
            "Any local `idf.py menuconfig` tweak not present in sdkconfig.defaults is being discarded; "
            "put it in sdkconfig.defaults if it should survive.\n"
            "Previous config saved as sdkconfig.superseded.")
        file(RENAME "${_sdkcfg}" "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.superseded")
    endif()
    file(WRITE "${_stamp}" "${_defaults_hash}")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)


# ── Make LVGL asserts speak ──────────────────────────────────────────────────────────────────────────
# LV_ASSERT_HANDLER is `while(1);` ("Halt by default") and LV_USE_ASSERT_MALLOC / _NULL are on, so any
# failed allocation or NULL inside LVGL spins the LVGL task forever: the screen freezes, the task watchdog
# prints a backtrace every 5s, and the rest of the firmware keeps running so the device looks alive but is
# not. LVGL logging was also off, so it died without a word — which is why several rounds of diagnosis only
# ever saw "stuck somewhere in the draw pipeline".
#
# CONFIG_LV_USE_LOG is now on (see sdkconfig): the assert prints its reason before halting. Overriding the
# handler itself to abort() was tried and abandoned — CMake eats the trailing semicolon of a compile
# definition, expanding the macro without a terminator and breaking lv_assert.h.
project(interns_commander)
