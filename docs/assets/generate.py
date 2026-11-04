#!/usr/bin/env python3
"""Draws the README's diagrams and charts as animated SVGs, in the app's pixel style.

    python3 docs/assets/generate.py

Everything is self-contained: GitHub shows these through an <img> tag, which can't load fonts,
so headings are drawn from a small pixel font below. Animations are CSS inside each file, and
stop for anyone who asked their system for reduced motion.
"""
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).parent

# ---- measured numbers: refresh these from a real run, never by hand-waving ----------------------
# Lines of code, tests included: Go, then TypeScript/HTML/CSS. Counted from git at each commit.
CODE = [
    ("With calendar and Claude", 14732, 13089),  # 0646732
    ("Timer with a Go server", 4982, 6285),  # b2e0356
    ("Browser only (now)", 0, None),  # counted below when this runs
]
# What a visitor downloads, in kB. The first and last two are the build's own transfer estimates
# (`ng build`); fonts are the six .woff2 files, and a browser fetches only the weights in use.
SIZES = [
    ("First load: app and Angular", 98.45),
    ("Fonts, at most", 81.23),
    ("Brew page", 7.71),
    ("Progress page, when opened", 3.94),
]
TESTS = 28 + 14  # unit tests + browser tests


def lines_now():
    """Today's frontend, counted the same way as the commits above."""
    root = OUT.parent.parent / "frontend"
    files = [f for folder in ("src", "e2e") for f in (root / folder).rglob("*") if f.suffix in (".ts", ".html", ".css", ".mjs")]
    return sum(f.read_bytes().count(b"\n") for f in files)


CODE[2] = (CODE[2][0], 0, lines_now())

# ---- the app's colors ----------------------------------------------------------------------------
BG, SURFACE, SURFACE3 = "#000000", "#111111", "#1a1a1a"
LINE, LINE2 = "#2c2c2c", "#3a3a3a"
TEXT, TEXT2, TEXT3 = "#efebe9", "#bdbdbd", "#a3a3a3"
ACCENT, ACCENT2 = "#d4a574", "#e8c49a"
GREEN, RED = "#8fd19e", "#ef5350"
COFFEE, COFFEE_TOP, MUTED = "#6f4e37", "#a67c52", "#8d7a68"
SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"

# ---- a 5x7 pixel font ------------------------------------------------------------------------------
GLYPHS = {
    "A": "01110 10001 10001 11111 10001 10001 10001", "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01110 10001 10000 10000 10000 10001 01110", "D": "11110 10001 10001 10001 10001 10001 11110",
    "E": "11111 10000 10000 11110 10000 10000 11111", "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01110 10001 10000 10111 10001 10001 01111", "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "01110 00100 00100 00100 00100 00100 01110", "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001", "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001", "N": "10001 11001 10101 10011 10001 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110", "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101", "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110", "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110", "V": "10001 10001 10001 10001 10001 01010 00100",
    "W": "10001 10001 10001 10101 10101 11011 10001", "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 01010 00100 00100 00100 00100", "Z": "11111 00001 00010 00100 01000 10000 11111",
    "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11111 00010 00100 00010 00001 10001 01110",
    "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100",
    ":": "00000 00100 00100 00000 00100 00100 00000", ".": "00000 00000 00000 00000 00000 00100 00100",
    "-": "00000 00000 00000 11111 00000 00000 00000", " ": "00000 00000 00000 00000 00000 00000 00000",
}


def pixel_width(text, scale):
    return (len(text) * 6 - 1) * scale


def pixel_text(text, x, y, scale, fill, anchor="start", extra=""):
    """Text drawn as one path of squares. y is the top of the letters."""
    if anchor == "middle":
        x -= pixel_width(text, scale) / 2
    elif anchor == "end":
        x -= pixel_width(text, scale)
    d = []
    for i, ch in enumerate(text.upper()):
        for r, row in enumerate(GLYPHS[ch].split()):
            for c, on in enumerate(row):
                if on == "1":
                    d.append(f"M{x + (i * 6 + c) * scale:g} {y + r * scale:g}h{scale}v{scale}h-{scale}z")
    return f'<path fill="{fill}" d="{"".join(d)}" {extra}/>'


def label(text, x, y, size=14, fill=TEXT2, anchor="start", weight=400):
    return (f'<text x="{x}" y="{y}" font-family="{SANS}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}">{escape(text)}</text>')


def panel(x, y, w, h, border=LINE, fill=SURFACE, extra=""):
    """The app's pixel box: a 3px border with notched corners."""
    b = 3
    return (f'<g {extra}><rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}"/>'
            f'<rect x="{x}" y="{y - b}" width="{w}" height="{b}" fill="{border}"/>'
            f'<rect x="{x}" y="{y + h}" width="{w}" height="{b}" fill="{border}"/>'
            f'<rect x="{x - b}" y="{y}" width="{b}" height="{h}" fill="{border}"/>'
            f'<rect x="{x + w}" y="{y}" width="{b}" height="{h}" fill="{border}"/></g>')


def flow(x1, y1, x2, y2, color=ACCENT, cls="flow"):
    """A line with dashes running along it, ending in a stepped pixel arrowhead at (x2, y2)."""
    if y1 == y2:
        s = 1 if x2 > x1 else -1
        end = x2 - 12 * s
        head = "".join(
            f'<rect x="{min(end + i * 4 * s, end + i * 4 * s + 4 * s)}" y="{y2 - h / 2}" width="4" height="{h}"/>'
            for i, h in enumerate((14, 8, 2)))
        line = f'<line class="{cls}" x1="{x1}" y1="{y1}" x2="{end}" y2="{y2}" stroke="{color}" stroke-width="3"/>'
    else:
        s = 1 if y2 > y1 else -1
        end = y2 - 12 * s
        head = "".join(
            f'<rect x="{x2 - h / 2}" y="{min(end + i * 4 * s, end + i * 4 * s + 4 * s)}" width="{h}" height="4"/>'
            for i, h in enumerate((14, 8, 2)))
        line = f'<line class="{cls}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{end}" stroke="{color}" stroke-width="3"/>'
    return f'{line}<g fill="{color}">{head}</g>'


def write(name, width, height, title, css, body):
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" aria-label="{escape(title, {'"': '&quot;'})}">
<title>{escape(title)}</title>
<style>
.flow {{ stroke-dasharray: 8 8; animation: flow 1s linear infinite; }}
@keyframes flow {{ to {{ stroke-dashoffset: -16; }} }}
{css}
@media (prefers-reduced-motion: reduce) {{ * {{ animation: none !important; }} }}
</style>
<rect width="{width}" height="{height}" fill="{BG}"/>
{body}
</svg>
"""
    (OUT / name).write_text(svg, encoding="utf-8")
    print(f"{name}: {len(svg.encode()) // 1024} KB")


# ---- the mug: the same rectangles the app draws ------------------------------------------------------
BODY = [(32, 40, 120, 8, "#E8E8E8")] + [(24, 48 + i * 8, 136, 8, "#F5F5F5" if i % 3 == 2 else "#FFFFFF") for i in range(13)] + [
    (24, 152, 136, 8, "#F0F0F0"), (24, 160, 136, 8, "#E8E8E8"), (32, 168, 120, 8, "#E0E0E0"), (40, 176, 104, 8, "#D8D8D8")]
OUTLINE = [(32, 32, 120, 8), (24, 40, 8, 8), (152, 40, 8, 8), (16, 48, 8, 136), (160, 48, 8, 120), (16, 176, 8, 8), (24, 184, 8, 8),
           (32, 184, 120, 8), (152, 184, 8, 8), (160, 168, 8, 16), (160, 56, 8, 8), (168, 48, 16, 8), (184, 56, 8, 16), (192, 72, 8, 56),
           (184, 128, 8, 16), (168, 144, 16, 8), (160, 136, 8, 8)]
HANDLE = [(168, 56, 16, 8, "#FFFFFF"), (176, 64, 8, 8, "#FFFFFF"), (184, 72, 8, 56, "#F5F5F5"), (176, 72, 8, 56, "#E8E8E8"),
          (176, 128, 8, 8, "#FFFFFF"), (168, 136, 8, 8, "#F0F0F0")]


def rects(items, fill=None):
    return "".join(f'<rect x="{r[0]}" y="{r[1]}" width="{r[2]}" height="{r[3]}" fill="{fill or r[4]}"/>' for r in items)


def mug(x, y, scale, coffee):
    """The mug at (x, y). coffee is the animated liquid, drawn between the cup and its outline."""
    return (f'<g transform="translate({x} {y}) scale({scale})" shape-rendering="crispEdges">{rects(BODY)}{coffee}'
            f'{rects(HANDLE)}{rects(OUTLINE, "#2A2A2A")}</g>')


SHADOW = 'transform="translate(2 2)"'  # the clock's drop shadow, as on the app's mug


def hero():
    # 12 seconds: drains for 8.4 (focus), holds, refills (break).
    frames = ["25:00", "20:00", "15:00", "10:00", "05:00", "00:00"]
    css = """
.liquid { transform-box: fill-box; transform-origin: 50% 100%; animation: drain 12s infinite; }
.surface { animation: fall 12s infinite; }
@keyframes drain { 0% { transform: scaleY(1); animation-timing-function: steps(15, end); } 70%, 78% { transform: scaleY(0); animation-timing-function: steps(15, end); } 100% { transform: scaleY(1); } }
@keyframes fall { 0% { transform: translateY(0); animation-timing-function: steps(15, end); } 70%, 78% { transform: translateY(120px); animation-timing-function: steps(15, end); } 100% { transform: translateY(0); } }
.bar { transform-box: fill-box; transform-origin: 0 50%; animation: bar 12s infinite; }
@keyframes bar { 0% { transform: scaleX(0); animation-timing-function: steps(24, end); } 70%, 100% { transform: scaleX(1); } }
.puff { animation: puff 2.4s steps(6, end) infinite; }
@keyframes puff { from { transform: translateY(8px); opacity: 0; } 25% { opacity: .7; } to { transform: translateY(-16px); opacity: 0; } }
.t { opacity: 0; }
"""
    readouts = ""
    # Each time shows for its slice of the drain, then BREAK shows while the mug refills.
    slices = [(0, 14), (14, 28), (28, 42), (42, 56), (56, 70), (70, 78)]
    for i, (text, (a, b)) in enumerate(zip(frames, slices)):
        css += f"@keyframes t{i} {{ {a}%, {b - 0.01}% {{ opacity: 1; }} {b}%, 100% {{ opacity: 0; }} }}\n"
        if a > 0:
            css = css.replace(f"@keyframes t{i} {{ {a}%,", f"@keyframes t{i} {{ 0%, {a - 0.01}% {{ opacity: 0; }} {a}%,")
        css += f".t{i} {{ animation: t{i} 12s infinite; }}\n"
        readouts += f'<g class="t t{i}">{pixel_text(text, 93, 101, 3, "#000000", "middle", SHADOW)}{pixel_text(text, 93, 101, 3, TEXT, "middle")}</g>'
    css += "@keyframes t6 { 0%, 77.99% { opacity: 0; } 78%, 100% { opacity: 1; } }\n.t6 { animation: t6 12s infinite; }\n"
    readouts += f'<g class="t t6">{pixel_text("BREAK", 93, 101, 3, "#000000", "middle", SHADOW)}{pixel_text("BREAK", 93, 101, 3, GREEN, "middle")}</g>'
    coffee = (f'<rect class="liquid" x="24" y="48" width="136" height="120" fill="{COFFEE}"/>'
              f'<rect class="surface" x="24" y="40" width="136" height="8" fill="{COFFEE_TOP}"/>{readouts}')
    steam = "".join(
        f'<rect class="puff" x="{x}" y="{y}" width="8" height="8" fill="#ffffff" style="animation-delay:{d}s"/>'
        for x, y, d in [(120, 28, 0), (150, 18, 0.7), (180, 28, 1.4), (135, 8, 1.1), (165, 4, 1.9)])
    segments = "".join(f'<rect x="{390 + i * 22}" y="212" width="18" height="10"/>' for i in range(24))
    body = (mug(60, 22, 1.15, coffee) + steam
            + pixel_text("BREW", 390, 62, 8, TEXT) + pixel_text("FOCUS", 620, 62, 8, ACCENT)
            + label("A pomodoro timer that runs entirely in your browser.", 390, 158, 22, TEXT)
            + label("No server. No accounts. Nothing leaves your device.", 390, 188, 16, TEXT3)
            + f'<clipPath id="segs">{segments}</clipPath>'
            + f'<g clip-path="url(#segs)"><rect x="390" y="212" width="524" height="10" fill="{LINE}"/>'
              f'<rect class="bar" x="390" y="212" width="524" height="10" fill="{ACCENT}"/></g>')
    write("hero.svg", 1000, 290, "Brew Focus: a pixel-art mug drains as the timer counts down, then refills on a break", css, body)


def architecture():
    css = """
.ghost { opacity: .9; }
.pulse { animation: pulse 3s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .55; } }
"""
    def box(x, y, w, h, title, sub, border=LINE2, color=TEXT):
        return (panel(x, y, w, h, border) + pixel_text(title, x + w / 2, y + 18, 2, color, "middle")
                + label(sub, x + w / 2, y + 56, 14, TEXT2, "middle"))

    def ghost(x, text):
        y, w, h = 26, 146, 70
        return (panel(x, y, w, h, LINE, BG, 'class="ghost"') + pixel_text(text, x + w / 2, y + 18, 2, MUTED, "middle")
                + f'<path stroke="{RED}" stroke-width="3" d="M{x + w / 2 - 7} {y + 42}l14 14m0 -14l-14 14"/>')

    y1, h1 = 190, 84
    cols = [(52, 186), (290, 186), (528, 186), (766, 186)]
    body = (
        box(40, 26, 300, 70, "GITHUB PAGES", "static files, downloaded once", ACCENT)
        + flow(190, 100, 190, 139)
        + ghost(482, "SERVER") + ghost(644, "ACCOUNTS") + ghost(806, "TRACKING")
        + f'<rect x="26" y="142" width="948" height="314" fill="none" stroke="{ACCENT}" stroke-width="3" stroke-dasharray="12 8"/>'
        + pixel_text("YOUR BROWSER", 44, 156, 2, ACCENT)
        + box(cols[0][0], y1, cols[0][1], h1, "SCREENS", "Brew, Progress, dialogs")
        + box(cols[1][0], y1, cols[1][1], h1, "BREW", "state and focus flow")
        + box(cols[2][0], y1, cols[2][1], h1, "STORE", "rules, deadline, events", ACCENT, ACCENT2)
        + box(cols[3][0], y1, cols[3][1], h1, "LOCALSTORAGE", "one JSON document")
        # Actions go right; events and data come back left.
        + flow(242, y1 + 26, 284, y1 + 26) + flow(284, y1 + 58, 242, y1 + 58, GREEN)
        + flow(480, y1 + 26, 522, y1 + 26) + flow(522, y1 + 58, 480, y1 + 58, GREEN)
        + flow(718, y1 + 26, 760, y1 + 26) + flow(760, y1 + 58, 718, y1 + 58, GREEN)
        + flow(650, y1 + h1 + 6, 650, 356, ACCENT) + flow(592, 356, 592, y1 + h1 + 6, GREEN)
        + box(528, 360, 186, 80, "OTHER TABS", "stay in step")
        + label("BroadcastChannel", 664, 322, 13, TEXT3)
        + box(766, 360, 186, 80, "WEB LOCK", "one tab ends each block")
        + f'<line class="flow" x1="714" y1="400" x2="760" y2="400" stroke="{ACCENT}" stroke-width="3"/>'
        + f'<rect x="52" y="360" width="16" height="16" fill="{ACCENT}"/>' + label("actions", 76, 373, 14, TEXT2)
        + f'<rect x="52" y="388" width="16" height="16" fill="{GREEN}"/>' + label("events and data", 76, 401, 14, TEXT2)
    )
    write("architecture.svg", 1000, 470, "Everything runs in the browser: screens talk to the Brew service, which talks to the Store, which saves to localStorage. No server, accounts or tracking.", css, body)


def focus_flow():
    # One bright box walks around the cycle every 10 seconds.
    steps = [("INTENTION", "what's this block for?"), ("BREATHE", "optional box breathing"), ("FOCUS", "the mug drains"),
             ("REFLECT", "one line, saved"), ("BREAK", "the mug refills")]
    w, gap, x0, y = 160, 32, 44, 26
    css = ""
    n = len(steps)
    body = ""
    for i, (title, sub) in enumerate(steps):
        x = x0 + i * (w + gap)
        a, b = i * 100 / n, (i + 1) * 100 / n
        before = f"0%, {a - 0.01:g}% {{ opacity: 0; }} " if a else ""
        after = f"{b:g}%, 100% {{ opacity: 0; }}"
        css += f"@keyframes on{i} {{ {before}{a:g}%, {b - 0.01:g}% {{ opacity: 1; }} {after} }}\n.on{i} {{ animation: on{i} 10s infinite; opacity: 0; }}\n"
        color = GREEN if title == "BREAK" else ACCENT
        body += panel(x, y, w, 96, LINE2)
        body += panel(x, y, w, 96, color, SURFACE3, f'class="on{i}"')
        body += pixel_text(title, x + w / 2, y + 26, 2, TEXT, "middle")
        body += label(sub, x + w / 2, y + 62, 13, TEXT2, "middle")
        if title in ("FOCUS", "BREAK"):  # the coffee level, moving only during this step
            start, end = ("1", "0") if title == "FOCUS" else ("0", "1")
            css += (f"@keyframes lvl{i} {{ 0%, {a:g}% {{ transform: scaleX({start}); }} {b:g}%, 100% {{ transform: scaleX({end}); }} }}\n"
                    f".lvl{i} {{ transform-box: fill-box; transform-origin: 0 50%; animation: lvl{i} 10s steps(12, end) infinite; }}\n")
            body += f'<rect x="{x + 24}" y="{y + 76}" width="{w - 48}" height="8" fill="{LINE}"/>'
            body += f'<rect class="lvl{i}" x="{x + 24}" y="{y + 76}" width="{w - 48}" height="8" fill="{color}"/>'
        if i < n - 1:
            body += flow(x + w + 4, y + 48, x + w + gap - 4, y + 48)
    left, right, low = x0 + w / 2, x0 + (n - 1) * (w + gap) + w / 2, y + 138
    body += (f'<path class="flow" d="M{right} {y + 102}V{low}H{left}V{y + 116}" fill="none" stroke="{GREEN}" stroke-width="3"/>'
             + flow(left, y + 116, left, y + 102, GREEN)
             + label("and again", (left + right) / 2, low + 22, 14, TEXT3, "middle"))
    write("flow.svg", 1000, 200, "The focus cycle: intention, optional breathing, focus while the mug drains, a one-line reflection, then a break while it refills", css, body)


def timer():
    # An illustration, not a measurement: what each approach does as a tab loses attention.
    x0, x1, top, base = 190, 950, 74, 270
    stops = [("OPEN", 190, 430, SURFACE3), ("BACKGROUND", 430, 620, "#20180f"), ("CLOSED", 620, 790, BG), ("OPEN", 790, 950, SURFACE3)]
    deadline = f"M{x0} {base}L{x1} {top}"
    pts = [(190, 270), (430, 208), (620, 186), (790, 186), (950, 145)]
    counter = "M" + "L".join(f"{x} {y}" for x, y in pts)
    css = f"""
.draw {{ stroke-dasharray: 1000; stroke-dashoffset: 1000; animation: draw 9s linear infinite; }}
@keyframes draw {{ to {{ stroke-dashoffset: 0; }} }}
.now {{ animation: now 9s linear infinite; }}
@keyframes now {{ from {{ transform: translateX(0); }} to {{ transform: translateX({x1 - x0}px); }} }}
.gap {{ animation: gap 9s linear infinite; }}
@keyframes gap {{ 0%, 94% {{ opacity: 0; }} 97%, 100% {{ opacity: 1; }} }}
"""
    bands = ""
    for name, a, b, fill in stops:
        bands += f'<rect x="{a}" y="{top - 44}" width="{b - a - 3}" height="{base - top + 44}" fill="{fill}"/>'
        bands += pixel_text(name, (a + b) / 2, top - 34, 2, TEXT3, "middle")
    body = (
        bands
        + f'<line x1="{x0}" y1="{base}" x2="{x1}" y2="{base}" stroke="{LINE2}"/>'
        + label("Time counted, by real time", x1, base + 22, 13, TEXT3, "end")
        + f'<path class="draw" d="{counter}" fill="none" stroke="{MUTED}" stroke-width="3" pathLength="1000"/>'
        + f'<path class="draw" d="{deadline}" fill="none" stroke="{ACCENT}" stroke-width="3" pathLength="1000"/>'
        + f'<line class="now" x1="{x0}" y1="{top - 10}" x2="{x0}" y2="{base}" stroke="{TEXT}" stroke-width="2"/>'
        + f'<g class="gap"><line x1="{x1 - 6}" y1="{top + 4}" x2="{x1 - 6}" y2="141" stroke="{RED}" stroke-width="3"/>'
        + label("time lost", x1 - 16, 114, 14, RED, "end", 600) + "</g>"
        + f'<rect x="26" y="150" width="14" height="14" fill="{ACCENT}"/>' + label("Saved deadline", 48, 162, 15, ACCENT, "start", 600)
        + label("always right", 48, 182, 13, TEXT2)
        + f'<rect x="26" y="212" width="14" height="14" fill="{MUTED}"/>' + label("Counting ticks", 48, 224, 15, MUTED, "start", 600)
        + label("falls behind", 48, 244, 13, TEXT2)
        + label("Illustration", 26, 44, 13, TEXT3)
        + label("remaining = ends_at − now", x0, base + 22, 14, TEXT, "start", 600)
    )
    write("timer.svg", 1000, 310, "A counter falls behind when a tab is throttled or closed. A saved deadline stays right, because time left is worked out from the end time.", css, body)


def security():
    wall = 470
    lanes = [
        ("This site's scripts, styles, fonts", True, 62),
        ("Injected script", False, 118),
        ("Scripts from other sites", False, 174),
        ("Sending your data elsewhere", False, 230),
    ]
    css = f"""
.pass {{ animation: pass 3.2s linear infinite; }}
@keyframes pass {{ 0% {{ transform: translateX(0); opacity: 0; }} 10% {{ opacity: 1; }} 90% {{ opacity: 1; }} 100% {{ transform: translateX(210px); opacity: 0; }} }}
.block {{ animation: block 3.2s linear infinite; }}
@keyframes block {{ 0% {{ transform: translateX(0); fill: {RED}; opacity: 0; }} 10% {{ opacity: 1; }} 50% {{ transform: translateX(96px); opacity: 1; }} 62%, 100% {{ transform: translateX(96px); opacity: 0; }} }}
"""
    body = ""
    for i, (text, allowed, y) in enumerate(lanes):
        color = GREEN if allowed else RED
        body += label(text, 30, y + 5, 15, TEXT)
        delay = f'style="animation-delay:{i * 0.4}s"'
        if allowed:
            body += f'<line x1="360" y1="{y}" x2="580" y2="{y}" stroke="{LINE2}" stroke-width="3"/>'
            body += f'<rect class="pass" x="360" y="{y - 6}" width="12" height="12" fill="{color}" {delay}/>'
        else:
            body += f'<line x1="360" y1="{y}" x2="{wall - 4}" y2="{y}" stroke="{LINE2}" stroke-width="3"/>'
            body += f'<rect class="block" x="360" y="{y - 6}" width="12" height="12" fill="{color}" {delay}/>'
            body += f'<path stroke="{RED}" stroke-width="3" d="M{wall + 14} {y - 8}L{wall + 30} {y + 8}M{wall + 30} {y - 8}L{wall + 14} {y + 8}"/>'
    body += f'<rect x="{wall}" y="30" width="6" height="228" fill="{ACCENT}"/>'
    body += pixel_text("POLICY", wall + 3, 266, 2, ACCENT, "middle")
    px, py, pw, ph = 590, 34, 380, 224
    body += panel(px, py, pw, ph, LINE2)
    body += pixel_text("NOTHING TO BREAK INTO", px + pw / 2, py + 22, 2, ACCENT, "middle")
    for i, text in enumerate(["No server", "No accounts or passwords", "No cookies", "Nothing sent anywhere"]):
        y = py + 74 + i * 36
        body += f'<rect x="{px + 28}" y="{y - 12}" width="14" height="14" fill="{GREEN}"/>'
        body += label(text, px + 54, y, 17, TEXT)
    write("security.svg", 1000, 296, "A strict page policy lets in only this site's own files and blocks injected scripts, outside scripts and data leaving. With no server or accounts, there's nothing to break into.", css, body)


def deploy():
    # One step lights up at a time, and the last one is the live site.
    steps = [("PUSH", "to main"), ("SCAN", "secrets, packages"), ("UNIT", "28 tests"), ("BUILD", "path from repo name"), ("BROWSER", "14 tests"), ("LIVE", "GitHub Pages")]
    n, w, gap, x0, y = len(steps), 136, 24, 22, 22
    css, body = "", ""
    for i, (title, sub) in enumerate(steps):
        x = x0 + i * (w + gap)
        a, b = i * 100 / n, (i + 1) * 100 / n
        before = f"0%, {a - 0.01:g}% {{ opacity: 0; }} " if a else ""
        css += f"@keyframes s{i} {{ {before}{a:g}%, {b - 0.01:g}% {{ opacity: 1; }} {b:g}%, 100% {{ opacity: 0; }} }}\n.s{i} {{ animation: s{i} 9s infinite; opacity: 0; }}\n"
        color = GREEN if title == "LIVE" else ACCENT
        body += panel(x, y, w, 84, LINE2) + panel(x, y, w, 84, color, SURFACE3, f'class="s{i}"')
        body += pixel_text(title, x + w / 2, y + 22, 2, GREEN if title == "LIVE" else TEXT, "middle")
        body += label(sub, x + w / 2, y + 62, 12, TEXT2, "middle")
        if i < n - 1:
            body += flow(x + w + 3, y + 42, x + w + gap - 3, y + 42)
    write("deploy.svg", 1000, 128, "Every push to main: scan, unit tests, build, browser tests, then publish. A failure at any step leaves the live site as it was.", css, body)


def stats():
    tiles = [("0", "servers"), ("0", "accounts"), ("0", "cookies"), ("0", "outside requests"), (str(TESTS), "tests")]
    w, gap = 186, 12
    css = "@keyframes rise { from { opacity: 0; transform: translateY(12px); } }\n"
    body = ""
    for i, (value, text) in enumerate(tiles):
        x = 11 + i * (w + gap)
        color = ACCENT if value != "0" else TEXT
        delay = f'style="animation: rise .8s {i * 0.12}s both"'
        body += (f'<g {delay}>' + panel(x, 12, w, 104, LINE2)
                 + pixel_text(value, x + w / 2, 30, 5, color, "middle") + label(text, x + w / 2, 94, 15, TEXT2, "middle") + "</g>")
    write("stats.svg", 1000, 128, f"Zero servers, accounts, cookies and outside requests, and {TESTS} tests", css, body)


def chart_code():
    # Two series, so a legend; totals labelled at the ends, and nothing else.
    css = """
.grow { transform-box: fill-box; transform-origin: 0 50%; animation: grow 1.4s cubic-bezier(.16,1,.3,1) both; }
@keyframes grow { from { transform: scaleX(0); } }
"""
    x0, width, top, rowh, thick = 250, 610, 84, 50, 24
    biggest = max(g + w for _, g, w in CODE)
    body = (label("Lines of code, tests included", 24, 32, 18, TEXT, "start", 600)
            + f'<rect x="24" y="48" width="14" height="14" fill="{MUTED}"/>' + label("Go", 44, 60, 14, TEXT2)
            + f'<rect x="84" y="48" width="14" height="14" fill="{ACCENT}"/>' + label("TypeScript, HTML, CSS", 104, 60, 14, TEXT2))
    for i, (name, go, web) in enumerate(CODE):
        y = top + i * rowh
        wg, ww = go / biggest * width, web / biggest * width
        gap = 2 if go else 0
        body += label(name, x0 - 14, y + 17, 14, TEXT if i == len(CODE) - 1 else TEXT2, "end", 600 if i == len(CODE) - 1 else 400)
        body += f'<g class="grow" style="animation-delay:{i * 0.15}s">'
        if go:
            body += f'<rect x="{x0}" y="{y}" width="{wg - gap:.1f}" height="{thick}" fill="{MUTED}"/>'
        body += f'<rect x="{x0 + wg:.1f}" y="{y}" width="{ww:.1f}" height="{thick}" fill="{ACCENT}"/></g>'
        body += label(f"{go + web:,}", x0 + wg + ww + 10, y + 17, 14, TEXT, "start", 600)
    write("chart-code.svg", 1000, 244, f"Lines of code: {CODE[0][1] + CODE[0][2]:,} with calendar and Claude, {CODE[1][1] + CODE[1][2]:,} with a Go server, {CODE[2][2]:,} now", css, body)


def chart_size():
    # One series, so no legend: the title says what's plotted.
    css = """
.grow { transform-box: fill-box; transform-origin: 0 50%; animation: grow 1.4s cubic-bezier(.16,1,.3,1) both; }
@keyframes grow { from { transform: scaleX(0); } }
"""
    x0, width, top, rowh, thick = 250, 610, 60, 44, 24
    biggest = max(v for _, v in SIZES)
    body = label("What a visitor downloads, in kB, compressed", 24, 32, 18, TEXT, "start", 600)
    for i, (name, value) in enumerate(SIZES):
        y = top + i * rowh
        w = max(value / biggest * width, 4)
        body += label(name, x0 - 14, y + 17, 14, TEXT2, "end")
        body += f'<rect class="grow" style="animation-delay:{i * 0.15}s" x="{x0}" y="{y}" width="{w:.1f}" height="{thick}" fill="{ACCENT}"/>'
        body += label(f"{value:g}", x0 + w + 10, y + 17, 14, TEXT, "start", 600)
    write("chart-size.svg", 1000, 244, "What a visitor downloads: " + ", ".join(f"{n} {v:g} kB" for n, v in SIZES), css, body)


if __name__ == "__main__":
    hero()
    architecture()
    focus_flow()
    timer()
    security()
    deploy()
    stats()
    chart_code()
    chart_size()
