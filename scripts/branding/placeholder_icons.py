#!/usr/bin/env python3
"""Draws Triage's placeholder app icon (ROADMAP P0-2) with Pillow.

Writes the files that replace VS Code's icons in the app build (app/resources/
mirrors upstream's resources/ folder; app/build.mjs copies it over the checkout):

    python3 scripts/branding/placeholder_icons.py

A real icon replaces this before v1.0 (P8). The design: a teal rounded square
with a white "T" and an amber dot, readable at 16 px.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "app" / "resources"
TEAL = (15, 118, 110, 255)
WHITE = (255, 255, 255, 255)
AMBER = (245, 158, 11, 255)
SUPERSAMPLE = 4


def draw(size: int) -> Image.Image:
    s = size * SUPERSAMPLE
    image = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(image)
    margin = round(s * 0.06)
    d.rounded_rectangle((margin, margin, s - margin, s - margin), radius=round(s * 0.2), fill=TEAL)
    bar = round(s * 0.15)
    top = round(s * 0.24)
    d.rounded_rectangle((round(s * 0.22), top, round(s * 0.78), top + bar), radius=bar // 3, fill=WHITE)
    d.rounded_rectangle((round(s * 0.5) - bar // 2, top, round(s * 0.5) + bar // 2, round(s * 0.78)),
                        radius=bar // 3, fill=WHITE)
    r = round(s * 0.075)
    cx, cy = round(s * 0.72), round(s * 0.7)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=AMBER)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    (OUT / "linux").mkdir(parents=True, exist_ok=True)
    (OUT / "win32").mkdir(parents=True, exist_ok=True)
    draw(1024).save(OUT / "linux" / "code.png", optimize=True)
    draw(70).save(OUT / "win32" / "code_70x70.png", optimize=True)
    draw(150).save(OUT / "win32" / "code_150x150.png", optimize=True)
    big = draw(256)
    big.save(OUT / "win32" / "code.ico",
             sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    for path in sorted(OUT.rglob("*")):
        if path.is_file():
            print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
