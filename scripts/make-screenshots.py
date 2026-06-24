#!/usr/bin/env python3
"""Compose Adobe Marketplace screenshots (1360x800) from raw panel captures.

Each output = brand-gradient background + caption (left) + the panel capture
(right) with rounded corners and a soft drop shadow. Run from repo root.
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1360, 800
GRAD_TL = (38, 128, 235)   # #2680eb
GRAD_BR = (123, 91, 255)   # #7b5bff
OUT_DIR = "marketplace"
LOGO = "marketplace/listing-icon-96.png"

SHOTS = [
    {
        "src": os.path.expanduser("~/Desktop/raw-overview.png"),
        "out": "marketplace/screenshot-1-overview.png",
        "title": "Separate audio without\nleaving Premiere",
        "subtitle": "Load a clip from your timeline, project, or a local file — then split it into clean per-speaker stems with one click.",
    },
    {
        "src": os.path.expanduser("~/Desktop/raw-stems.png"),
        "out": "marketplace/screenshot-2-stems.png",
        "title": "Split any clip into\nper-speaker stems",
        "subtitle": "Toggle each voice, ride its level, and mix only what you want — then send a clean track straight back to Premiere.",
    },
    {
        "src": os.path.expanduser("~/Desktop/raw-script.png"),
        "out": "marketplace/screenshot-3-script.png",
        "title": "Check the script,\nfix who-said-what",
        "subtitle": "A timecoded transcript with speaker editing and one-tap reassign, then rebuild the audio to match.",
    },
]


def font(size, bold=False):
    paths = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size, index=1 if bold else 0)
            except Exception:
                return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def gradient(w, h, tl, br):
    base = Image.new("RGB", (w, h))
    px = base.load()
    # diagonal blend factor 0..1 along (x+y)
    maxd = (w - 1) + (h - 1)
    for y in range(h):
        for x in range(w):
            t = (x + y) / maxd
            px[x, y] = (
                int(tl[0] + (br[0] - tl[0]) * t),
                int(tl[1] + (br[1] - tl[1]) * t),
                int(tl[2] + (br[2] - tl[2]) * t),
            )
    return base


def wrap(draw, text, fnt, max_w):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=fnt) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], radius=radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def compose(shot, bg_cache):
    bg = bg_cache.copy()
    draw = ImageDraw.Draw(bg)

    panel = Image.open(shot["src"]).convert("RGBA")
    max_w, max_h = 640, 660
    scale = min(max_w / panel.width, max_h / panel.height)
    pw, ph = int(panel.width * scale), int(panel.height * scale)
    panel = panel.resize((pw, ph), Image.LANCZOS)
    panel = rounded(panel, 16)

    px = W - 80 - pw          # right-aligned, 80px right margin
    py = (H - ph) // 2

    # soft drop shadow
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle([px + 10, py + 16, px + pw + 10, py + ph + 16], radius=16, fill=(0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    bg = Image.alpha_composite(bg.convert("RGBA"), shadow).convert("RGB")
    bg.paste(panel, (px, py), panel)
    draw = ImageDraw.Draw(bg)

    # caption column on the left
    cx = 80
    cap_w = px - cx - 40

    # logo chip + wordmark
    cy = py if ph < 600 else 120
    if os.path.exists(LOGO):
        chip = Image.open(LOGO).convert("RGBA").resize((44, 44), Image.LANCZOS)
        bg.paste(chip, (cx, cy), chip)
        draw.text((cx + 56, cy + 8), "Vibi: AI Sound Eraser", font=font(26, bold=True), fill=(255, 255, 255))
    cursor = cy + 80

    # title (may contain \n)
    tf = font(50, bold=True)
    for line in shot["title"].split("\n"):
        draw.text((cx, cursor), line, font=tf, fill=(255, 255, 255))
        cursor += 60
    cursor += 16

    sf = font(24)
    for line in wrap(draw, shot["subtitle"], sf, cap_w):
        draw.text((cx, cursor), line, font=sf, fill=(238, 240, 255))
        cursor += 34

    bg.save(shot["out"])
    print(f"wrote {shot['out']} ({W}x{H})")


def main():
    bg = gradient(W, H, GRAD_TL, GRAD_BR)
    for shot in SHOTS:
        compose(shot, bg)


if __name__ == "__main__":
    main()
