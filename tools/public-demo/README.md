# Squatch Rig public demo

[![Pages](https://github.com/squatch-stack/squatch-rig-demo/actions/workflows/pages.yml/badge.svg)](https://github.com/squatch-stack/squatch-rig-demo/actions/workflows/pages.yml)
[![Code: MIT](https://img.shields.io/badge/code-MIT-blue)](LICENSE)
[![Art: All Rights Reserved](https://img.shields.io/badge/art-all%20rights%20reserved-lightgrey)](LICENSE)

**[Open the browser demo](https://squatch-stack.github.io/squatch-rig-demo/)**: a guitar rig in a browser tab, with four playable
quick sounds, light and dark themes and two device skins. Press Play (or Space); nothing to install.

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/rig-row1-dark.jpg">
  <img src="docs/readme/rig-row1-light.jpg" alt="The demo rig, first part: the DI input, then Gate, Squash (the compressor) and Trail Drive (an overdrive), each a pedal with its plate art" width="475">
</picture>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/rig-row2-dark.jpg">
  <img src="docs/readme/rig-row2-light.jpg" alt="Second part: Stack Drive (the second overdrive), the NAM Core head (the NAM amp), the Cab 4x12 and the Env Filter" width="567">
</picture>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/rig-row3-dark.jpg">
  <img src="docs/readme/rig-row3-light.jpg" alt="Last part: Hall (the reverb), Limiter and the output" width="363">
</picture>
</p>

Squash is the compressor, Trail Drive and Stack Drive are two overdrives, and the NAM Core head is the NAM amp.

Screenshots of the page itself: [light](docs/readme/rig-light.jpg), [dark](docs/readme/rig-dark.jpg),
[phone](docs/readme/rig-phone.jpg). Measured from the effect code the page runs:

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/fig-compressor-dark.svg">
  <img src="docs/readme/fig-compressor-light.svg" alt="Compressor gain reduction against input level for ratios 2, 4 and 8, measured dots on theory lines" width="430">
</picture>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme/fig-reverb-dark.svg">
  <img src="docs/readme/fig-reverb-light.svg" alt="Reverb energy decay for decay settings of 1, 2.5 and 5 seconds" width="430">
</picture>
</p>

## How this repository becomes the demo

This repository holds the sources of a static site, exported from the development tree with `tools/export-public.mjs`. The NAM
engine (`nam.wasm`) is never committed: GitHub Actions builds it from pinned public sources (`wasm-src/PINS`: stock upstream NAM
Core, and a second, opt-in `nam-experimental.wasm` that adds `wasm-src/experimental-fast.patch`; a pinned Emscripten), scans the
whole site, attests the build and deploys it to Pages. The job names below are the workflow's own.

```mermaid
flowchart LR
  accTitle: From the sources to the live demo
  accDescr: The development tree is exported to this repository. The build job builds the wasm files from pinned sources, assembles the site, scans it and attests the wasm. The deploy job publishes it to GitHub Pages.
  dev["development tree"] -- "tools/export-public.mjs" --> repo["this repository:<br/>site sources"]
  repo --> j_build["build: wasm from wasm-src/PINS,<br/>assemble the site, scan, attest"] --> j_deploy["deploy to<br/>GitHub Pages"]
```

## More

The editor's source, tests and measurements are in [squatch-rig](https://github.com/squatch-stack/squatch-rig). The same
effects as desktop plugins are in [squatch-dsp](https://github.com/squatch-stack/squatch-dsp), and the tuner has its own
[repository](https://github.com/squatch-stack/squatch-tuner) and [demo](https://tuner.squatch.cc/). The rig
also lives at [rig.squatch.cc](https://rig.squatch.cc/); [squatch.cc/work/rig](https://squatch.cc/work/rig/) tells the story.

## Credits and licences

The bundled NAM Core example models are MIT licensed; the playable DI loops carry their credits and licences in
`{{ASSET_BASE}}/audio/loops/index.json` and in the app. The DI test excerpt is from the “Five guitar dataset” by Eduard Vergés
Franch (2021), [Zenodo 10.5281/zenodo.4988354](https://doi.org/10.5281/zenodo.4988354), trimmed, resampled, and normalized
under CC BY 4.0. Source code is MIT licensed; the device and brand art is All Rights Reserved (see LICENSE). No private captures
are included.
