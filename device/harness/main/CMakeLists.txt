# Single "main" component holding all app sources. Board drivers live under board/
# and the LVGL UI under ui/.
idf_component_register(
    SRCS
        "app_main.c"
        "ram_telemetry.c"
        "config_store.c"
        "device_mac.c"
        "cable_frame.c"
        "cable_link.c"
        "last_words.c"
        "cable_client.c"
        "cable_machines.c"
        "fw_update.c"
        "audio_capture.c"
        "audio_client.c"
        "ptt.c"
        "board/board_i2c.c"
        "board/board.c"
        "board/board_table.c"
        "board/power.c"
        "ui/display.c"
        "ui/touch.c"
        "ui/ui_screens.c"
        "ui/carousel_ring.c"
        "ui/geist_reg_20.c"
        "ui/geist_reg_25.c"
        "ui/geist_med_28.c"
        "ui/geist_med_32.c"
        "ui/geist_reg_34.c"
        "ui/geist_reg_38.c"
        "ui/geist_reg_16.c"
        "ui/geist_reg_24.c"
        "ui/geist_reg_32.c"
        "ui/geist_med_48.c"
        "ui/geist_med_64.c"
        "ui/geist_sem_24.c"
        "ui/geist_med_38.c"
        "ui/icons_settings.c"
        "ui/spinner_spokes.c"
        "ui/icons_engine.c"
        "ui/icons_voice.c"
    INCLUDE_DIRS
        "."
        "ui"
        "board"
    REQUIRES
        nvs_flash
        esp_wifi
        esp_netif
        esp_event
        esp_http_server
        esp_http_client
        esp_https_ota
        app_update
        esp_partition
        mbedtls
        libsodium
        esp_websocket_client
        esp-tls
        esp_lcd
        esp_lcd_touch
        esp_codec_dev
        esp_timer
        driver
        json
        lvgl
)

# snprintf() is bounded (it truncates, never overflows), but -O2 enables a noisy
# format-truncation analysis that errors on safe same-size copies. Keep it as a warning, not error.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)

# PROD build override: `idf.py -DDEVICE_FORCE_PROD=1 build` (into a separate build dir) forces the
# production backend and ignores any local provisioned_config.h — no need to move the header, so the LOCAL
# and PROD build dirs both stay warm (no CMake-reconfigure churn). See app_main.c's DEVICE_FORCE_PROD.
if(DEVICE_FORCE_PROD)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_FORCE_PROD=1)
endif()

# LOCAL BACKEND override: `idf.py -DDEVICE_BACKEND_URL="ws://<laptop-ip>:8085" build` points the device
# at a backend on your machine. The URL is otherwise hardcoded to production AND re-forced over whatever
# NVS holds on every boot (app_main.c), so it is not a setting the device can be talked into — a local
# build is the only way. Only the URL changes: the device keeps its provisioned WiFi and SDS credential,
# so there is no need to bake credentials in or re-run setup just to move the socket.
if(DEVICE_BACKEND_URL)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_PROD_BACKEND_URL="${DEVICE_BACKEND_URL}")
endif()

# BRING-UP PROBE: `idf.py -DBOARD_PROBE=1 build` (separate build dir recommended). app_main runs
# board/board_probe.c before the display comes up and prints what is on the I2C bus, which reset pins
# do what, and what each touch driver reads idle. Never set for a release image.
if(BOARD_PROBE)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE BOARD_PROBE=1)
    target_sources(${COMPONENT_LIB} PRIVATE "board/board_probe.c")
endif()
