#!/usr/bin/env python3
"""Draws Triage's logo and writes every icon the app build uses.

The logo is the owner's design (2026-11-24): a T with a slanted bar (the right
arm 3/4 the height of the left), three dashes down the stem's right edge, a gap
on the left level with the gap after the third dash, and a bottom cut at 45
degrees. Inside, white PCB traces: a three-track bus from the left arm into the
stem, two traces in the right arm, one in the bottom piece. Colour: K3 Slate.

    python3 scripts/branding/icons.py

Writes (app/build.mjs copies app/resources/ and app/src/ over the checkout):
    app/resources/linux/code.png                Linux app icon (1024 px)
    app/resources/win32/code.ico                Windows app icon (16-256 px)
    app/resources/win32/code_70x70.png, code_150x150.png   Start menu tiles
    app/resources/win32/inno-{big,small}-*.bmp  installer wizard images
    app/src/vs/workbench/browser/media/code-icon.svg       title bar, Welcome
    app/src/vs/sessions/browser/media/vscode-icon.svg      Agents window
    app/src/vs/workbench/browser/parts/editor/media/letterpress-*.svg  watermark
    app/src/vs/sessions/contrib/aquarium/browser/vscodeLogoPath.ts     silhouette
    app/src/vs/triage/browser/media/triage-logo-dark.svg   reversed, for dark themes
    docs/brand/triage-logo.svg, triage-logo-1024.png      the logo itself
    docs/brand/triage-logo-reversed.svg                    on dark backgrounds

Units: x = the height of the left arm. Origin: the top of the bar at the stem's
left edge; y grows downwards.
"""
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESOURCES = ROOT / "app" / "resources"
SRC = ROOT / "app" / "src" / "vs"
BRAND = ROOT / "docs" / "brand"

COLOUR = "#1e293b"  # K3 Slate, the owner's choice
WHITE = "#ffffff"
# The reversed logo for dark backgrounds (the owner's option C): light T, slate traces.
REVERSED_FILL, REVERSED_LINES = "#f1f5f9", COLOUR

# --- The T ---
X = 1.0  # left arm height
R = 0.75 * X  # right arm height
W = 1.25  # stem width
L = 1.5  # bottom length of each arm
NOTCH = 0.2  # how deep the gaps cut into the stem
GAP = 0.55  # every gap: between the dashes, after the third dash, and on the left
GAP_TOP = 3.73  # where the left gap and the gap after the third dash start
BELOW_GAP = 0.4  # right edge of the bottom piece, between the gap and the cut
XL, XR = 0.0, W
DASH = (GAP_TOP - R - 2 * GAP) / 3
DIAG_TOP = GAP_TOP + GAP + BELOW_GAP  # where the 45-degree cut meets the right edge
H = DIAG_TOP + W  # the stem's bottom point

# --- The traces (each starts outside an edge and is clipped to the T) ---
TRACE = 0.085
PAD_R = 0.12
PAD_RING = 0.06
COLS = (0.875, 0.625, 0.375)  # stem columns of the bus, outer to inner
ROWS = (0.25, 0.5, 0.75)  # left-arm rows of the bus, outer to inner
CHAMFER = (0.45, 0.30, 0.16)  # 45-degree bends, evenly spaced around the turn
ENDS = tuple(R + DASH / 2 + i * (DASH + GAP) for i in range(3))  # pads beside the dashes
TRACES = [
    [(-3.0, row), (col - k, row), (col, row + k), (col, end)]
    for row, col, k, end in zip(ROWS, COLS, CHAMFER, ENDS)
] + [
    [(3.6, 0.25), (1.75, 0.25)],  # right arm
    [(3.6, 0.5), (2.3, 0.5)],
    [(0.375, H + 0.2), (0.375, GAP_TOP + GAP + 0.37)],  # bottom piece, from the cut
]

MIN_X, MAX_X = XL - L - X, XR + L + R
SIZE = max(MAX_X - MIN_X, H)


def outline() -> list[tuple[float, float]]:
    pts = [(MIN_X, 0), (MAX_X, 0), (XR + L, R), (XR, R)]
    y = R
    for _ in range(3):  # three dashes, each followed by a gap
        y += DASH
        pts += [(XR, y), (XR - NOTCH, y), (XR - NOTCH, y + GAP), (XR, y + GAP)]
        y += GAP
    pts += [(XR, DIAG_TOP), (XL, H), (XL, GAP_TOP + GAP), (XL + NOTCH, GAP_TOP + GAP),
            (XL + NOTCH, GAP_TOP), (XL, GAP_TOP), (XL, X), (XL - L, X)]
    return pts


def frame(margin: float):
    """The square (in units) the logo sits centred in: left, top, side."""
    side = SIZE + 2 * margin
    left = MIN_X - (side - (MAX_X - MIN_X)) / 2
    top = -(side - H) / 2
    return left, top, side


def _f(v: float) -> str:
    return f"{v:.3f}".rstrip("0").rstrip(".")


# --- SVG ---

def svg_parts(fill: str, lines: str):
    poly = " ".join(f"{_f(x)},{_f(y)}" for x, y in outline())
    traces = "".join(
        '<path d="M' + " L".join(f"{_f(x)} {_f(y)}" for x, y in t) + '"/>' for t in TRACES
    )
    pads = "".join(
        f'<circle cx="{_f(t[-1][0])}" cy="{_f(t[-1][1])}" r="{_f(PAD_R)}" fill="{fill}" '
        f'stroke="{lines}" stroke-width="{_f(PAD_RING)}"/>'
        for t in TRACES
    )
    return poly, traces, pads


def logo_svg(fill: str = COLOUR, lines: str = WHITE, margin: float = 0.2) -> str:
    left, top, side = frame(margin)
    poly, traces, pads = svg_parts(fill, lines)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{_f(left)} {_f(top)} {_f(side)} {_f(side)}">'
        f'<defs><clipPath id="t"><polygon points="{poly}"/></clipPath></defs>'
        f'<polygon points="{poly}" fill="{fill}"/>'
        f'<g clip-path="url(#t)" fill="none" stroke="{lines}" stroke-width="{_f(TRACE)}" '
        f'stroke-linejoin="round">{traces}</g>'
        f'<g clip-path="url(#t)">{pads}</g></svg>\n'
    )


def letterpress_svg(attrs: str, fill: str = "") -> str:
    """The editor watermark: one colour, the traces cut out (upstream's is 260 x 260)."""
    left, top, side = frame(0.3)
    poly, traces, _ = svg_parts("#000", "#000")
    holes = "".join(
        f'<circle cx="{_f(t[-1][0])}" cy="{_f(t[-1][1])}" r="{_f(PAD_R + PAD_RING / 2)}" fill="#000"/>'
        f'<circle cx="{_f(t[-1][0])}" cy="{_f(t[-1][1])}" r="{_f(PAD_R - PAD_RING / 2)}" fill="#fff"/>'
        for t in TRACES
    )
    return (
        f'<svg width="260" height="260" viewBox="{_f(left)} {_f(top)} {_f(side)} {_f(side)}" {attrs} '
        f'xmlns="http://www.w3.org/2000/svg"><defs><mask id="m" maskUnits="userSpaceOnUse">'
        f'<rect x="{_f(left)}" y="{_f(top)}" width="{_f(side)}" height="{_f(side)}" fill="#fff"/>'
        f'<g fill="none" stroke="#000" stroke-width="{_f(TRACE)}" stroke-linejoin="round">{traces}</g>'
        f'{holes}</mask></defs><polygon points="{poly}" {fill}mask="url(#m)"/></svg>\n'
    )


def logo_path_ts() -> str:
    """The Agents window draws the logo from this path in a 96 x 96 box (6 to 90)."""
    scale = 84 / SIZE
    dx = 6 + (84 - (MAX_X - MIN_X) * scale) / 2 - MIN_X * scale
    dy = 6 + (84 - H * scale) / 2
    d = "M" + "L".join(f"{_f(dx + x * scale)} {_f(dy + y * scale)}" for x, y in outline()) + "Z"
    return (
        "/*---------------------------------------------------------------------------------------------\n"
        " *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).\n"
        " *  Replaces VS Code's logo silhouette (ROADMAP P0-9). Generated by\n"
        " *  scripts/branding/icons.py.\n"
        " *--------------------------------------------------------------------------------------------*/\n\n"
        "// Triage's T, without its traces.\n"
        f"export const VSCODE_LOGO_PATH = '{d}';\n"
    )


# --- Raster (Pillow) ---

def raster(size: int, traces: bool = True, margin: float = 0.2, background=None):
    """The logo as an RGBA (or RGB on `background`) image of size x size pixels."""
    from PIL import Image, ImageDraw

    ss = 4  # supersampling
    n = size * ss
    left, top, side = frame(margin)
    k = n / side

    def p(x: float, y: float):
        return ((x - left) * k, (y - top) * k)

    body = Image.new("RGBA", (n, n), COLOUR)
    if traces:
        d = ImageDraw.Draw(body)
        width = max(1, round(TRACE * k))
        for t in TRACES:
            d.line([p(*pt) for pt in t], fill=WHITE, width=width, joint="curve")
        for t in TRACES:
            cx, cy = p(*t[-1])
            outer, inner = (PAD_R + PAD_RING / 2) * k, (PAD_R - PAD_RING / 2) * k
            d.ellipse((cx - outer, cy - outer, cx + outer, cy + outer), fill=WHITE)
            d.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill=COLOUR)
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).polygon([p(*pt) for pt in outline()], fill=255)
    body.putalpha(mask)
    image = body.resize((size, size), Image.Resampling.LANCZOS)
    if background is None:
        return image
    plate = Image.new("RGB", image.size, background)
    plate.paste(image, mask=image.getchannel("A"))
    return plate


def ico_images():
    # Below 48 px the traces would be thinner than a pixel: the T alone reads better.
    return [raster(s, traces=s >= 48, margin=0.1) for s in (16, 24, 32, 48, 64, 128, 256)]


# Installer wizard images: upstream's sizes for each Windows display scale.
INNO = {
    100: ((164, 314), (55, 55)),
    125: ((192, 386), (64, 68)),
    150: ((246, 459), (83, 80)),
    175: ((273, 556), (92, 97)),
    200: ((328, 604), (110, 106)),
    225: ((355, 700), (119, 123)),
    250: ((410, 797), (138, 140)),
}


def inno_image(size: tuple[int, int], fraction: float):
    from PIL import Image

    width, height = size
    side = round(min(width, height) * fraction)
    logo = raster(side, traces=side >= 48, margin=0.05, background="#ffffff")
    image = Image.new("RGB", size, "#ffffff")
    image.paste(logo, ((width - side) // 2, (height - side) // 2))
    return image


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        path.write_text(data, newline="\n")
    else:
        data()
    print(path.relative_to(ROOT))


def main() -> None:
    svg = logo_svg()
    write(SRC / "workbench" / "browser" / "media" / "code-icon.svg", svg)
    write(SRC / "sessions" / "browser" / "media" / "vscode-icon.svg", svg)
    write(SRC / "sessions" / "contrib" / "aquarium" / "browser" / "vscodeLogoPath.ts", logo_path_ts())
    letterpress = SRC / "workbench" / "browser" / "parts" / "editor" / "media"
    write(letterpress / "letterpress-light.svg", letterpress_svg('opacity="0.1"'))
    write(letterpress / "letterpress-dark.svg", letterpress_svg('opacity="0.3"'))
    write(letterpress / "letterpress-hcLight.svg", letterpress_svg('fill="none"', 'fill="#D9D9D9" '))
    write(letterpress / "letterpress-hcDark.svg", letterpress_svg('fill="none"', 'fill="#3C3C3C" '))
    reversed_svg = logo_svg(REVERSED_FILL, REVERSED_LINES)
    write(SRC / "triage" / "browser" / "media" / "triage-logo-dark.svg", reversed_svg)
    # The Agents window's own mark (the "Open in Agents" title-bar button and the
    # Agents window). Upstream's "-light" file is the light mark for dark themes,
    # "-dark" the dark one for light themes (.vs, .hc-light).
    sessions = SRC / "sessions" / "browser" / "media"
    write(sessions / "sessions-icon.svg", svg)
    write(sessions / "sessions-logo-light.svg", reversed_svg)
    write(sessions / "sessions-logo-dark.svg", svg)
    write(BRAND / "triage-logo.svg", svg)
    write(BRAND / "triage-logo-reversed.svg", reversed_svg)

    linux = RESOURCES / "linux" / "code.png"
    write(linux, lambda: raster(1024).save(linux, optimize=True))
    brand_png = BRAND / "triage-logo-1024.png"
    write(brand_png, lambda: raster(1024).save(brand_png, optimize=True))
    win = RESOURCES / "win32"
    for s in (70, 150):
        tile = win / f"code_{s}x{s}.png"
        write(tile, lambda tile=tile, s=s: raster(s, traces=s >= 48, margin=0.1).save(tile, optimize=True))
    ico = win / "code.ico"
    images = ico_images()
    write(ico, lambda: images[-1].save(ico, sizes=[i.size for i in images], append_images=images[:-1]))
    for scale, (big, small) in INNO.items():
        b, s = win / f"inno-big-{scale}.bmp", win / f"inno-small-{scale}.bmp"
        write(b, lambda b=b, big=big: inno_image(big, 0.62).save(b))
        write(s, lambda s=s, small=small: inno_image(small, 0.86).save(s))


if __name__ == "__main__":
    assert math.isclose(R, 0.75 * X)
    main()
