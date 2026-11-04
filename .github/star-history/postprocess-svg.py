#!/usr/bin/env python3
"""Post-process the rendered star-history SVGs for GitHub's raw host.

Two fixes, both forced by the CSP raw.githubusercontent.com serves the chart
with:

    default-src 'none'; style-src 'unsafe-inline'; sandbox

strip_blocked_images() drops the repo-avatar <image> the renderer puts next to
the chart title. No img-src means no image source is permitted at all, data:
URIs included, so the avatar cannot load and the browser draws a broken-image
icon in its place. The title text is centred with text-anchor="middle"
independently of the avatar, so removing it leaves the heading correct.

embed_font() re-embeds the @font-face the renderer strips out, on the
assumption GitHub drops it. camo does allow it (its CSP names img-src data:
and style-src 'unsafe-inline'), which is the case the renderer had in mind.

The font is Patrick Hand (SIL OFL), which reads as hand-drawn without the
non-commercial clause that star-history.com's own xkcd Script carries. To
switch faces, drop a new woff2 next to this script and point FONT at it.
"""
import base64
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).parent
FONT = HERE / "patrick-hand.woff2"
# The vendored star-history renderer asks for this family by name, so whatever
# face FONT points at has to be declared under it.
FAMILY = "xkcd"


def strip_blocked_images(text: str) -> tuple[str, int]:
    """Remove every <image> element, plus any clip path left with no referent."""
    text, dropped = re.subn(r"<image\b[^>]*/>", "", text)
    if not dropped:
        return text, 0
    # The renderer wraps the avatar's clip path in its own <svg><defs>. Drop any
    # clip path nothing points at any more, then the container if it went empty.
    for clip in re.findall(r'<clipPath id="([^"]+)">.*?</clipPath>', text):
        if f"url(#{clip})" not in text:
            text = re.sub(
                r'<clipPath id="%s">.*?</clipPath>' % re.escape(clip), "", text
            )
    text = text.replace("<svg><defs></defs></svg>", "")
    return text, dropped


def main(out_dir: str) -> int:
    b64 = base64.b64encode(FONT.read_bytes()).decode("ascii")
    face = (
        '<defs><style type="text/css">'
        f'@font-face{{font-family:"{FAMILY}";'
        f"src:url(data:font/woff2;base64,{b64}) format('woff2');"
        "font-weight:normal;font-style:normal;}</style></defs>"
    )

    svgs = sorted(pathlib.Path(out_dir).glob("*.svg"))
    if not svgs:
        print(f"No SVGs in {out_dir}; nothing to do.")
        return 0

    for svg in svgs:
        text = svg.read_text(encoding="utf-8")

        text, dropped = strip_blocked_images(text)
        if dropped:
            print(f"{svg.name}: dropped {dropped} CSP-blocked <image> element(s)")

        if "@font-face" in text:
            print(f"{svg.name}: already has @font-face, skipping font")
        else:
            # Insert immediately after the opening <svg ...> tag.
            cut = text.index(">") + 1
            text = text[:cut] + face + text[cut:]
            print(f"{svg.name}: embedded {FONT.name}")

        svg.write_text(text, encoding="utf-8")
        print(f"{svg.name}: {len(text.encode()) // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "assets/star-history"))
