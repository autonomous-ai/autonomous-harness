# UI Redesign (draft) — Voice-first handheld controller

> **Status:** rough concept for review (Option A from the brainstorm). Not implemented.
> **Goal:** device is used as a **handheld controller** — voice / answer / stop must be fast and
> obvious — and it should look **premium & native to the round AMOLED**. Full redesign of screens,
> navigation, and flow. Network / pairing / OTA layers unchanged.

## Design principles
1. **One focused project at a time.** No "swipe-first-then-act". The screen is always *about* the
   project you're controlling right now.
2. **One persistent primary action.** A big bottom button whose meaning changes with turn state:
   `Talk → Stop → Answer`. You never hunt for it.
3. **The round edge is the state.** A ring around the whole screen shows the turn state (idle /
   thinking / asking / error / done) — glanceable, and finally uses the curved bezel instead of
   fighting it.
4. **Push-to-talk = physical button (walkie-talkie).** Hold button B to talk, release to send. The
   on-screen mic is only an indicator.
5. **Non-destructive overlays.** Questions/readers slide up as sheets; you keep the project context.
6. **Premium basics:** custom icon glyphs, one accent + semantic colors, a real type scale, subtle
   motion only while a turn is active (battery-friendly).

---

## State → primary action (the core of the redesign)

| Turn state (from `commander_event.kind`) | Ring | Center | Primary button (bottom) |
|------------------------------------------|------|--------|--------------------------|
| idle (no turn) | dim grey | last summary / "Ready" | `● Talk` (accent) |
| thinking (`processing`/`say`/`act`) | animated blue | streaming say/act text | `■ Stop` (red) |
| asking (`commander_question`) | amber | question prompt | `➤ Answer` (amber) |
| done (`summary`/`done`) | green pulse → fades | the summary | `● Talk` |
| error | red | error text | `● Talk` |
| recording (PTT held) | green pulse | "Listening…" + level | `▮ Release to send` |

Physical button **B (GPIO0)** = hold-to-talk from any project screen. Touch primary button mirrors it
(tap Talk = start/stop; tap Stop = cancel; tap Answer = open sheet).

---

## Screen mockups (round 466×466; the border = the state ring)

### 1. Focused project — IDLE  (ring: dim)
```
           . - '''''''''''''' - .
        .'      14:23    82%      '.
      .'                            '.
     /                                \
    |          ▸ Project 1             |     small project name + ‹ › peek hint
    |                                  |
    |         ✓ Tests pass —           |     last summary (tap → full reader)
    |         auth refactor done       |
    |                                  |
     \        ╭──────────────╮        /
      '.      │   ●  Talk    │      .'        persistent primary action
        '.    ╰──────────────╯    .'
           ' - . _________ . - '
```

### 2. Focused project — THINKING  (ring: animated blue)
```
           . ~^~^~^~^~^~^~^~ . 
        .~      14:23    82%     ~.          ← ring animating (turn running)
      .~                           ~.
     ~                               ~
    |          ▸ Project 1            |
    |                                 |
    |       Editing websocket.ts,     |      live say/act text (streaming)
    |       running the tests…        |
    |                                 |
     ~       ╭──────────────╮        ~
      ~.     │   ■  Stop    │      .~        red — tap to interrupt
        ~.   ╰──────────────╯    .~
           ' ~ . _________ . ~ '
```

### 3. Focused project — ASKING  (ring: amber)
```
           . - '''''''''''''' - .
        .'      14:23    82%      '.
      .'                            '.
     /                                \
    |          ▸ Project 1             |
    |                                  |
    |     Which DB should I use?       |     question prompt
    |                                  |
    |                                  |
     \        ╭──────────────╮        /
      '.      │  ➤  Answer   │      .'        amber — opens the answer sheet
        '.    ╰──────────────╯    .'
           ' - . _________ . - '
```

### 4. Answer sheet (slides up over the project — keeps context)
```
           . - '''''''''''''' - .
        .'    Which DB to use?     '.
      .'   ┌────────────────────┐    '.
     /     │  🎤  Speak answer   │     \      voice answer first (always reachable)
    |      ├────────────────────┤      |
    |      │  Postgres          │      |     tap to pick (single) ·
    |      ├────────────────────┤      |     ✓ toggles for multi
    |      │  SQLite            │      |
     \     └────────────────────┘     /
      '.     swipe down to dismiss   .'
        '.  _______________________.'
           ' - . _________ . - '
```

### 5. Recording (PTT held)  (ring: green pulse)
```
           . ~~~~~~~~~~~~~~~~ .
        .~      14:23    82%     ~.
      .~                           ~.
     ~                               ~
    |          ▸ Project 1            |
    |                                 |
    |        ▁▃▅▇▅▃▁▃▅▇▅▃▁            |     live mic level
    |          Listening…             |
    |                                 |
     ~       ╭──────────────╮        ~
      ~.     │ ▮ Release ➜ send│    .~       release button B (or tap) to send
        ~.   ╰──────────────╯    .~
           ' ~ . _________ . ~ '
```

### 6. Project switch — horizontal carousel with peek
```
           . - '''''''''''''' - .
        .'      14:23    82%      '.
      .'                            '.
     /                                \
   ‹ P0    ▸ Project 1            P2 ›  |    neighbors peek at the edges
    |          ✓ Ready               |
    |                                 |
    |                                 |
    |            ·  ●  ·  ·           |     page arc (which project)
     \        ╭──────────────╮        /
      '.      │   ●  Talk    │      .'
        '.    ╰──────────────╯    .'
           ' - . _________ . - '
```
`+` tile at the end of the carousel (or long-press) → create a new project.

### 7. Pairing (redesigned, cleaner)  (ring: amber “waiting”)
```
           . - '''''''''''''' - .
        .'                        '.
      .'       Pair this device     '.
     /                                \
    |                                  |
    |          S 8 N 9 R X             |     big code, generous spacing
    |                                  |
    |     enter on app.interns · 4:59  |     hint + countdown
    |                                  |
     \                                /
      '.        ( • • • ·)          .'        progress dots while polling
        '.  ___________________ .'
           ' - . _________ . - '
```

### 8. Offline / error  (ring: red)
```
           . xxxxxxxxxxxxxx .
        .x      --:--            x.          ← ring red, wifi dim
      .x                           x.
     x                               x
    |                                 |
    |        No WiFi found            |
    |   Connect to a new network      |
    |        [ Setup WiFi ]           |     tap → portal
    |                                 |
     x                               x
      x.                           .x
        x. ___________________ .x
           ' x . _________ . x '
```

---

## Navigation model

```
        ┌─────────────── FOCUSED PROJECT (home) ───────────────┐
        │  center = state · bottom = primary action · ring=state │
        └───┬───────────────┬───────────────┬───────────────────┘
   swipe ◀▶ │        tap card│        Answer │        hold btn B
  carousel  │        ▼       │        ▼      │        ▼
  next/prev │   Reader sheet │  Answer sheet │   Recording (PTT)
            │   (full text)  │  (options)    │   release → send
   long-press / "+"            swipe down = dismiss back to focus
        ▼
   Create project
```

- **No separate "projects list" screen** — the carousel *is* navigation, always one swipe away.
- **Sheets, not screens** for reader/answer → dismiss by swipe-down, never lose the project.
- **Double-tap** = sleep/wake (unchanged). **Hold BOOT at power-on** = factory reset (unchanged).

---

## Component system (what has to be built)

| Component | Now | Redesign |
|-----------|-----|----------|
| State ring | dot in header + yellow busy row | `lv_arc` around the full 466 edge, color/animation per state |
| Primary action | mic + STOP, contextual position | one persistent bottom pill, context-aware label/color |
| Icons | ox-drawn rectangles (mic/stop) | small custom icon glyph set (talk/stop/answer/mic/check) baked into the font |
| Colors | ad-hoc hex | 1 accent + semantic set (blue thinking / amber ask / green done / red error / grey idle) |
| Type | Montserrat + font_viet_20 | keep font_viet for text; a display size for state; consistent scale |
| Overlays | full-screen swap | bottom sheets (reader, answer) over the focus screen |
| Motion | none | ring pulse/spin only while a turn is active (awake-only, battery-safe) |

## Impacted code (when we build it)
- `ui/ui_screens.c` — biggest change: replace tileview-home with focus screen + carousel + primary
  action + ring; reader/question become sheets. Reuse the event/dedup/utf8 logic.
- `ui/touch.c` — swipe-down-to-dismiss sheets; keep double-tap.
- `ptt.c` — switch toggle → true hold-to-talk (press=talk, release=send).
- `commander_client.c` — no protocol change; map `kind` → ring/primary state.
- New: a tiny icon glyph set (extend the font) + a `state` enum driving ring + primary button.

## Suggested phasing
1. **Focus screen + context-aware primary action + PTT hold** (kills the cluttered "active" screen, testable fast).
2. **State ring** (`lv_arc`) + color/motion system (the premium jump).
3. **Sheets** for reader + answer; **carousel** peek + `+` create.
4. *(optional, phase-later)* pull-down overview ring of all projects (borrowed from the ambient idea).

---

*Rough draft for review. Nothing here is implemented yet — say the word and I'll turn the phase-1
scope into a concrete implementation plan (screen-by-screen + file diffs).*
