#include "cable_machines.h"

#include <string.h>

// FNV-1a. Chosen for being three lines and dependency-free, not for its distribution: this compares two
// lists that are usually IDENTICAL, so what matters is that a real change never hashes equal — and any
// non-trivial mixing gives that. A collision here costs one skipped repaint, not correctness.
static uint32_t fnv1a(uint32_t h, const void *data, size_t n)
{
    const uint8_t *p = (const uint8_t *)data;
    for (size_t i = 0; i < n; i++) {
        h ^= p[i];
        h *= 16777619u;
    }
    return h;
}

static uint32_t fnv1a_str(uint32_t h, const char *s)
{
    return fnv1a(h, s, strlen(s) + 1);   // the nul is folded in, so "ab"+"c" != "a"+"bc"
}

#define FNV_OFFSET 2166136261u

static uint32_t row_hash(uint32_t h, const cable_machine_t *r)
{
    h = fnv1a_str(h, r->id);
    h = fnv1a_str(h, r->name);
    h = fnv1a_str(h, r->state);
    const uint8_t local = r->local ? 1 : 0;
    h = fnv1a(h, &local, 1);
    return h;
}

static void copy_field(char *dst, size_t cap, const char *src)
{
    if (!src) { dst[0] = '\0'; return; }
    size_t n = strlen(src);
    if (n >= cap) n = cap - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

void cable_machines_init(cable_machines_t *m)
{
    memset(m, 0, sizeof(*m));
    m->applied_hash = FNV_OFFSET;
}

void cable_machines_begin(cable_machines_t *m)
{
    m->count = 0;
    m->building = true;
    m->hash = FNV_OFFSET;
}

bool cable_machines_add(cable_machines_t *m, const char *id, const char *name,
                        const char *state, bool local)
{
    if (!m->building || !id || !id[0]) return false;
    // REJECTED, not truncated. A cut id can alias onto another machine's row, and the ✓ — plus every
    // turn the user then sends — would land on the wrong computer.
    if (strlen(id) >= MACHINE_ID_MAX) return false;
    if (m->count >= CABLE_MAX_MACHINES) return false;

    cable_machine_t *r = &m->rows[m->count++];
    memset(r, 0, sizeof(*r));
    copy_field(r->id, sizeof(r->id), id);
    copy_field(r->name, sizeof(r->name), name && name[0] ? name : id);
    copy_field(r->state, sizeof(r->state), state && state[0] ? state : "ready");
    r->local = local;
    // Folded HERE, in arrival order, so a reordered list hashes differently — order is render order.
    m->hash = row_hash(m->hash, r);
    return true;
}

bool cable_machines_end(cable_machines_t *m, const char *selected)
{
    m->building = false;
    const char *sel = selected ? selected : "";
    const uint32_t h = fnv1a_str(m->hash, sel);
    if (h == m->applied_hash && m->count == m->applied_count) return false;
    m->applied_hash = h;
    m->applied_count = m->count;
    copy_field(m->applied_selected, sizeof(m->applied_selected), sel);
    return true;
}

bool cable_machines_update(cable_machines_t *m, const char *id, const char *name,
                           const char *state, bool local)
{
    if (!id || !id[0]) return false;
    for (int i = 0; i < m->count; i++) {
        cable_machine_t *r = &m->rows[i];
        if (strcmp(r->id, id) != 0) continue;
        cable_machine_t next = *r;
        copy_field(next.name, sizeof(next.name), name && name[0] ? name : r->name);
        copy_field(next.state, sizeof(next.state), state && state[0] ? state : r->state);
        next.local = local;
        if (memcmp(&next, r, sizeof(next)) == 0) return false;
        *r = next;
        // Re-fold the whole list rather than trying to unmix one row: FNV is not invertible, and a
        // ten-element re-hash is cheaper than the bug that comes from pretending it is.
        uint32_t h = FNV_OFFSET;
        for (int j = 0; j < m->count; j++) h = row_hash(h, &m->rows[j]);
        m->hash = h;
        m->applied_hash = fnv1a_str(h, m->applied_selected);
        return true;
    }
    return false;
}

void cable_machines_clear(cable_machines_t *m)
{
    cable_machines_init(m);
}

const cable_machine_t *cable_machines_find(const cable_machines_t *m, const char *id)
{
    if (!id || !id[0]) return NULL;
    for (int i = 0; i < m->count; i++) {
        if (strcmp(m->rows[i].id, id) == 0) return &m->rows[i];
    }
    return NULL;
}
