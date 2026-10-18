#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Capture the README's screenshots of the demo rig, as the running page draws them: the whole page, the row of pedals, a phone.

    node server.mjs   (with the wasm files in web/wasm, see the README's "Run it"), then
    uv run --no-project --with playwright==1.55.0 --with pillow python tools/readme-shots.py [URL] [OUT_DIR]

Opens the page in headless Chromium at 1440x900, device scale 2, once per colour scheme, waits for the canvas to draw the
rig, and writes OUT_DIR/rig-{light,dark}.jpg (the page), rig-row{1,2,3}-{light,dark}.jpg (the row of devices in three
pieces, cropped from the real screenshot at its own pixels, so the README can show each pedal at the page's own size) and
rig-phone.jpg (390x844), default docs/readme.
Nothing is composed or redrawn: the pixels are the page's.
"""
import io
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7491/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "docs/readme")
# the device row at scale 2, with its names under it, cut between devices: DI to Trail Drive, Stack Drive to Env Filter,
# Hall to Output. Each piece keeps the screenshot's own pixels (no resize), and the README draws it at half its width.
ROWS = ((40, 830, 990, 1240), (990, 830, 2124, 1240), (2124, 830, 2850, 1240))


def shoot(browser, scheme, size):
    page = browser.new_context(viewport=size, device_scale_factor=2, color_scheme=scheme).new_page()
    page.goto(URL + f"?theme={scheme}", wait_until="load")
    page.wait_for_timeout(5000)
    return Image.open(io.BytesIO(page.screenshot())).convert("RGB")


def save(img, name, width):
    img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    img.save(OUT / name, quality=82, optimize=True)
    print("wrote", OUT / name)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for scheme in ("light", "dark"):
            shot = shoot(browser, scheme, {"width": 1440, "height": 900})
            save(shot, f"rig-{scheme}.jpg", 1400)
            for i, box in enumerate(ROWS, 1):
                row = shot.crop(box)
                save(row, f"rig-row{i}-{scheme}.jpg", row.width)
        save(shoot(browser, "light", {"width": 390, "height": 844}), "rig-phone.jpg", 600)
        browser.close()


if __name__ == "__main__":
    main()
