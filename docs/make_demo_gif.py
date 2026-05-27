#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
bg = (11, 18, 32)
panel = (15, 23, 42)
text = (229, 231, 235)
muted = (156, 163, 175)

try:
    font_big = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 58)
    font_med = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 28)
    font_small = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20)
    font_mono = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 22)
except Exception:
    font_big = ImageFont.load_default()
    font_med = ImageFont.load_default()
    font_small = ImageFont.load_default()
    font_mono = ImageFont.load_default()

frames = []
steps = [
    ("1. Observe", "snapshot({ includeActionMarks: true, includeStableLocator: true })"),
    ("2. Act", 'click("@e1")'),
    ("3. Reuse", "siteSkills() -> runSiteTool()"),
]

for i in range(12):
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((60, 60, 1220, 660), 28, fill=(8, 15, 27), outline=(31, 41, 55), width=2)
    d.rounded_rectangle((110, 112, 1170, 166), 14, fill=(17, 24, 39), outline=(51, 65, 85), width=1)
    for x, c in zip((145, 169, 193), ((239, 68, 68), (245, 158, 11), (34, 197, 94))):
        d.ellipse((x, 130, x + 12, 142), fill=c)
    d.text((235, 126), "ego-browser — agent-first browser control", fill=text, font=font_med)
    d.text((110, 210), "Snapshot. Act. Re-snapshot.", fill=(248, 250, 252), font=font_big)
    d.text((110, 272), "Real Chrome. Semantic snapshots. Reusable site learnings.", fill=muted, font=font_med)
    d.rounded_rectangle((110, 356, 450, 578), 18, fill=panel, outline=(51, 65, 85), width=1)
    d.text((142, 384), "Quick start", fill=text, font=font_small)
    for idx, (title, detail) in enumerate(steps):
        y = 430 + idx * 44
        alpha = 1.0 if i >= idx * 4 else 0.35
        base = tuple(int(v * alpha) for v in text)
        muted_base = tuple(int(v * alpha) for v in muted)
        d.text((142, y), title, fill=base, font=font_small)
        d.text((250, y), detail, fill=muted_base, font=font_small)
    d.rounded_rectangle((500, 356, 830, 578), 18, fill=panel, outline=(51, 65, 85), width=1)
    d.text((530, 384), "Snapshot output", fill=text, font=font_small)
    snap_lines = ["@e1 button Submit", "@e2 input Email", "@e3 link Export", "loc=css:button[type=submit]"]
    highlight = min(len(snap_lines), max(1, i // 3 + 1))
    for idx, line_text in enumerate(snap_lines):
        y = 430 + idx * 34
        c = text if idx < highlight else muted
        d.text((530, y), line_text, fill=c, font=font_mono)
    d.rounded_rectangle((860, 356, 1170, 578), 18, fill=panel, outline=(51, 65, 85), width=1)
    d.text((892, 384), "Reused after learning", fill=text, font=font_small)
    bar_w = 170 + i * 10
    d.rounded_rectangle((892, 442, 892 + bar_w, 470), 14, fill=(56, 189, 248))
    d.rounded_rectangle((892, 500, 1085, 528), 14, fill=(167, 139, 250))
    d.text((892, 548), "siteSkills() -> export_doc", fill=muted, font=font_small)
    d.text((110, 624), "Accessibility-tree snapshots • Stable locators • Site learnings", fill=muted, font=font_small)
    d.text((980, 624), "MIT · Node 22+ · v0.1.0", fill=muted, font=font_small)
    frames.append(img)

frames[0].save("docs/demo.gif", save_all=True, append_images=frames[1:], duration=140, loop=0, optimize=False)
