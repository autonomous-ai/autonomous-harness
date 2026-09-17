#include "ram_telemetry.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "ui/display.h"

static const char *TAG = "ram";

#define APP_INTERNAL_CAPS (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)
#define APP_PSRAM_CAPS    (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)

static bool s_initialized;
static volatile bool s_lvgl_ready;
static volatile uint32_t s_json_fallback_count;
static volatile uint64_t s_json_fallback_bytes;
static volatile uint32_t s_psram_failure_count;
static volatile uint64_t s_psram_failure_bytes;
static uint32_t s_periodic_count;

static void note_psram_failure(const char *owner, size_t bytes)
{
    __atomic_fetch_add(&s_psram_failure_count, 1, __ATOMIC_RELAXED);
    __atomic_fetch_add(&s_psram_failure_bytes, (uint64_t)bytes, __ATOMIC_RELAXED);
    ESP_LOGE(TAG, "PSRAM allocation failed owner=%s bytes=%u",
             owner ? owner : "unknown", (unsigned)bytes);
}

static void *cjson_psram_malloc(size_t bytes)
{
    void *ptr = heap_caps_malloc(bytes, APP_PSRAM_CAPS);
    if (ptr) return ptr;

    __atomic_fetch_add(&s_json_fallback_count, 1, __ATOMIC_RELAXED);
    __atomic_fetch_add(&s_json_fallback_bytes, (uint64_t)bytes, __ATOMIC_RELAXED);
    return heap_caps_malloc(bytes, APP_INTERNAL_CAPS);
}

static void cjson_heap_free(void *ptr)
{
    free(ptr);
}

void ram_telemetry_init(void)
{
    if (s_initialized) return;
    cJSON_Hooks hooks = {
        .malloc_fn = cjson_psram_malloc,
        .free_fn = cjson_heap_free,
    };
    cJSON_InitHooks(&hooks);
    s_initialized = true;
}

void ram_telemetry_set_lvgl_ready(void)
{
    s_lvgl_ready = true;
}

void *ram_psram_alloc(size_t bytes, const char *owner)
{
    void *ptr = heap_caps_malloc(bytes, APP_PSRAM_CAPS);
    if (!ptr && bytes) note_psram_failure(owner, bytes);
    return ptr;
}

void *ram_psram_calloc(size_t count, size_t size, const char *owner)
{
    if (count && size > SIZE_MAX / count) {
        note_psram_failure(owner, SIZE_MAX);
        return NULL;
    }
    void *ptr = heap_caps_calloc(count, size, APP_PSRAM_CAPS);
    if (!ptr && count && size) note_psram_failure(owner, count * size);
    return ptr;
}

void *ram_psram_realloc(void *ptr, size_t bytes, const char *owner)
{
    void *next = heap_caps_realloc(ptr, bytes, APP_PSRAM_CAPS);
    if (!next && bytes) note_psram_failure(owner, bytes);
    return next;
}

char *ram_psram_strdup(const char *src, const char *owner)
{
    if (!src) return NULL;
    size_t bytes = strlen(src) + 1;
    char *dst = ram_psram_alloc(bytes, owner);
    if (dst) memcpy(dst, src, bytes);
    return dst;
}

static void log_task_stack(const char *name)
{
    TaskHandle_t task = xTaskGetHandle(name);
    if (!task) return;
    ESP_LOGI(TAG, "STACK task=%s free_min=%u B",
             name, (unsigned)uxTaskGetStackHighWaterMark(task));
}

void ram_telemetry_checkpoint(const char *tag)
{
    lv_mem_monitor_t lv = { 0 };
    bool have_lvgl = s_lvgl_ready;
    if (have_lvgl) {
        display_lock();
        lv_mem_monitor(&lv);
        display_unlock();
    }

    uint32_t json_fallbacks = __atomic_load_n(&s_json_fallback_count, __ATOMIC_RELAXED);
    uint64_t json_fallback_bytes = __atomic_load_n(&s_json_fallback_bytes, __ATOMIC_RELAXED);
    uint32_t psram_failures = __atomic_load_n(&s_psram_failure_count, __ATOMIC_RELAXED);
    uint64_t psram_failure_bytes = __atomic_load_n(&s_psram_failure_bytes, __ATOMIC_RELAXED);

    ESP_LOGI(TAG,
             "RAM tag=%s int_free=%u int_min=%u int_largest=%u psram_free=%u psram_largest=%u "
             "lv_total=%u lv_free=%u lv_largest=%u lv_frag=%u%% json_fb=%u/%lluB psram_fail=%u/%lluB "
             "task=%s stack_free_min=%uB",
             tag ? tag : "unknown",
             (unsigned)heap_caps_get_free_size(APP_INTERNAL_CAPS),
             (unsigned)heap_caps_get_minimum_free_size(APP_INTERNAL_CAPS),
             (unsigned)heap_caps_get_largest_free_block(APP_INTERNAL_CAPS),
             (unsigned)heap_caps_get_free_size(APP_PSRAM_CAPS),
             (unsigned)heap_caps_get_largest_free_block(APP_PSRAM_CAPS),
             (unsigned)lv.total_size,
             (unsigned)lv.free_size,
             (unsigned)lv.free_biggest_size,
             have_lvgl ? (unsigned)lv.frag_pct : 0,
             (unsigned)json_fallbacks,
             (unsigned long long)json_fallback_bytes,
             (unsigned)psram_failures,
             (unsigned long long)psram_failure_bytes,
             pcTaskGetName(NULL),
             (unsigned)uxTaskGetStackHighWaterMark(NULL));
}

void ram_telemetry_periodic(const char *tag)
{
    ram_telemetry_checkpoint(tag);
    if (++s_periodic_count % 10 != 0) return;

    static const char *const tasks[] = {
        "lvgl",
        "proj_refresh",
        "ptt",
        "beep",
        "commander_ws",
    };
    for (size_t i = 0; i < sizeof(tasks) / sizeof(tasks[0]); i++) log_task_stack(tasks[i]);
}
