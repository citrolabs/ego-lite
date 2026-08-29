#!/usr/bin/env python3
"""Re-embed the chart font that star-history-action strips out.

The action removes the @font-face block on the assumption that GitHub drops it
from SVGs served via <img>. It does not. camo serves them with

    default-src 'none'; img-src data:; style-src 'unsafe-inline'

and a data:-URI font declared inside that inline style still loads (verified
against camo's exact header). Without this step the chart renders in the
browser's default sans-serif instead of the hand-drawn star-history look.

The font is xkcd Script, the same face star-history.com uses, subsetted to
printable ASCII so each SVG grows by ~27 KB rather than ~53 KB. To switch to a
different face, drop a new woff2 next to this script and point FONT at it.
"""
import base64
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
FONT = HERE / "xkcd-script.woff2"
# The vendored star-history renderer asks for this family by name.
FAMILY = "xkcd"


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
        if "@font-face" in text:
            print(f"{svg.name}: already has @font-face, skipping")
            continue
        # Insert immediately after the opening <svg ...> tag.
        cut = text.index(">") + 1
        svg.write_text(text[:cut] + face + text[cut:], encoding="utf-8")
        print(f"{svg.name}: embedded {FAMILY} ({svg.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "assets/star-history"))
