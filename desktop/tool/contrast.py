#!/usr/bin/env python3
"""WCAG contrast between two colours, with alpha composited over a ground.

Colour decisions in this app are CALCULATED, never judged from a screenshot: a
compressed, scaled or colour-managed image kills exactly the thin distinctions
this palette is built out of, and has raised three false alarms already.

Accepts both spellings the Dart source uses: '#RRGGBB' and '0xAARRGGBB'.

    ./tool/contrast.py                       # run the app's standing checks
    ./tool/contrast.py '#F5F5F5' '#181818'   # one pair
    ./tool/contrast.py '0x0DFFFFFF' '#181818' --over '#181818'

A translucent token has NO contrast ratio of its own. `AppSurface.hoverFill`
(0x0DFFFFFF) only means something once it is sitting on a named ground, so
composite it first — `--over` does that for you.
"""

import argparse
import sys


def _parse(h):
    """'#RRGGBB' or '0xAARRGGBB' -> (r, g, b, a) as floats in 0..1."""
    h = h.strip()
    # An explicit prefix strip. `h.lstrip('#').lstrip('0x')` looks equivalent and
    # is a real bug: lstrip removes *every* leading character in the set given,
    # so '0x0DFFFFFF' becomes 'DFFFFFF' — it eats the leading zero of the alpha
    # channel. Every translucent token in this palette starts with one.
    if h.startswith('#'):
        h = h[1:]
    elif h[:2].lower() == '0x':
        h = h[2:]
    if len(h) == 8:                                     # AARRGGBB
        a, r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4, 6))
        return r / 255, g / 255, b / 255, a / 255
    if len(h) == 6:                                     # RRGGBB
        r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
        return r / 255, g / 255, b / 255, 1.0
    raise ValueError(f'not a colour: {h!r}')


def composite(fg, bg):
    """Lay fg (possibly translucent) over an opaque bg. Returns '#RRGGBB'."""
    fr, fg_, fb, fa = _parse(fg)
    br, bg_, bb, _ = _parse(bg)
    return '#{:02X}{:02X}{:02X}'.format(
        round((fr * fa + br * (1 - fa)) * 255),
        round((fg_ * fa + bg_ * (1 - fa)) * 255),
        round((fb * fa + bb * (1 - fa)) * 255),
    )


def _srgb(c):
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def lum(h):
    r, g, b, _ = _parse(h)
    return 0.2126 * _srgb(r) + 0.7152 * _srgb(g) + 0.0722 * _srgb(b)


def contrast(a, b):
    """WCAG contrast ratio. Both colours must be opaque — composite() first."""
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


# The three floors, from §16. A surface next to a surface has no floor at all —
# separation there comes from shadow, not contrast (§9.1).
FLOOR_TEXT = 4.5      # WCAG 1.4.3 AA, body text
FLOOR_UI = 3.0        # WCAG 1.4.11, an icon / thumb / meaningful rim

# The palette, as `lib/shared/theme/app_theme.dart` states it. Keep in step with
# that file: a ratio written in a doc comment is a MEASUREMENT WITH A DATE, and
# moving a ground silently falsifies every number taken on top of it.
DARK = {
    'windowBg': '#181818',
    'cardBg': '#1E1E1E',
    'surfaceFill': '#202020',      # a raised block: dialog, popover
    'menuFill': '#2A2A2A',         # AppMenu.fillDark — floats over that block
    'hoverFill': '0x0DFFFFFF',
    'textPrimary': '#F5F5F5',
    'textSecondary': '#A8A8A2',
    'accent': '#2F5BEA',
    'accentOnSurface': '#6E8BFF',
    'rim': '0x1FFFFFFF',
}
LIGHT = {
    'windowBg': '#FFFFFF',
    'cardBg': '#F3F3F2',
    'surfaceFill': '#FFFFFF',
    'menuFill': '#FFFFFF',
    'hoverFill': '0x07000000',
    'textPrimary': '#1A1A18',
    'textSecondary': '#62615B',
    'accent': '#2F5BEA',
    'accentOnSurface': '#2F5BEA',
    'rim': '0x14000000',
}


def _row(label, ratio, floor=None):
    if floor is None:
        return f'  {label:<42} {ratio:>6.3f}:1'
    mark = 'ok ' if ratio >= floor else 'FAIL'
    return f'  {label:<42} {ratio:>6.3f}:1   {mark} (floor {floor})'


def standing_checks():
    """The checks worth re-running after any palette move."""
    bad = 0
    for name, p in (('DARK', DARK), ('LIGHT', LIGHT)):
        print(f'\n{name}')
        page = p['windowBg']
        block = p['surfaceFill']
        menu = p['menuFill']
        hovered = composite(p['hoverFill'], page)

        # Separation of the three readable layers (§9.2). No floor — these are
        # reported so a change that flattens them is visible, not to be passed.
        print(_row('menu panel vs page', contrast(menu, page)))
        print(_row('menu panel vs raised block', contrast(menu, block)))
        print(_row('raised block vs page', contrast(block, page)))

        # Ink, which does have a floor.
        checks = [
            ('body ink on page', contrast(p['textPrimary'], page), FLOOR_TEXT),
            ('body ink on menu panel',
             contrast(p['textPrimary'], menu), FLOOR_TEXT),
            ('secondary ink on menu panel',
             contrast(p['textSecondary'], menu), FLOOR_TEXT),
            ('body ink on a hovered row',
             contrast(p['textPrimary'], hovered), FLOOR_TEXT),
            ('white on accent fill',
             contrast('#FFFFFF', p['accent']), FLOOR_TEXT),
            ('accent mark on a hovered row',
             contrast(p['accentOnSurface'], hovered), FLOOR_UI),
        ]
        for label, ratio, floor in checks:
            print(_row(label, ratio, floor))
            if ratio < floor:
                bad += 1

        # The rim is the only border §1 permits, and in light it is the ONLY
        # thing drawing a white panel's edge — the fill above measures 1.000:1
        # against both grounds.
        #
        # NO FLOOR, deliberately, and this was worth getting wrong once: §16's
        # 3.0 is for a rim that CARRIES MEANING — a selected rail, a state
        # border. A panel's edge is a surface beside a surface, which §9.1 says
        # has no floor at all, because what separates the layers is the shadow.
        # A hairline forced to 3.0 is not a hairline; it is a hard black line,
        # and no macOS menu has one. Reported so a change that erases the edge
        # is visible, not to be passed or failed.
        print(_row('panel rim on the page',
                   contrast(composite(p['rim'], page), menu)))
        print(_row('panel rim on a raised block',
                   contrast(composite(p['rim'], block), menu)))
    print()
    return bad


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('colours', nargs='*', metavar='COLOUR',
                    help='two colours to compare; omit to run the standing checks')
    ap.add_argument('--over', metavar='GROUND',
                    help='composite each translucent colour over this ground first')
    args = ap.parse_args(argv)

    if not args.colours:
        return 1 if standing_checks() else 0
    if len(args.colours) != 2:
        ap.error('give exactly two colours, or none')

    a, b = args.colours
    if args.over:
        a, b = composite(a, args.over), composite(b, args.over)
        print(f'over {args.over}:  {args.colours[0]} -> {a}   '
              f'{args.colours[1]} -> {b}')
    print(f'{contrast(a, b):.3f}:1')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
