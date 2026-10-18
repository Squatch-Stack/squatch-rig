# design/ — skin drop point

The canvas draws every device with the **brush-ink** skin, `skin.brush-ink.json`, which maps the SVGs in
`assets/devices/` (generated art). `?skin=ink` selects the older built-in line art
(`web/js/ui/skin-ink.js`). The server mounts this folder at `/design/`.

Add `design/skin.<name>.json` and open the app with `?skin=<name>` to try another set of art. `{ways}` in a path
picks per-path-count art for the splitter and mixer (`"ways": [2, 3, 4]`):

```json
{ "name": "my-skin",
  "devices": {
    "overdrive": { "svg": "assets/devices/pedal-overdrive.svg", "scale": 0.8 },
    "splitter":  { "svg": "assets/devices/splitter-{ways}.svg", "ways": [2, 3, 4], "scale": 0.8 },
    "nam":       { "svg": "assets/devices/amp-head.svg", "scale": 0.5, "params": { "gain": "input", "master": "output" } } } }
```

Types: `input output gate compressor overdrive envfilter reverb limiter nam cab splitter mixer`.

Only the static body is swapped; knobs, jacks, the bypass switch, LEDs,
labels and each device's glyph are drawn live on top. Their positions come from the SVG's
anchor slots (`data-slot` = `jack-in[-a..d]`, `jack-out[-a..d]`, `knob` + `data-i`
with the parameter on `g.knob[data-param]`, `footswitch`/`toggle`, `led`,
`nameplate`, and `glyph`: the rect the live brush glyph is drawn into). The static
`g.glyph` group and any knob group the node type does not use are removed before rasterising. `"params": {"gain": "input"}` maps an art knob
name onto a node parameter; face parameters without a named slot take the
remaining knob slots in order. `var(--token, #fallback)` colours are replaced
per theme with the values in `web/css/app.css` (a skin may override them with `"themes": {"dark": {...}}`) before
the SVG is rasterised. Art with
fewer jacks than the node has ports falls back to the ink jack positions. A type without an entry keeps its ink drawing. An
unknown `?skin=` name falls back to the ink skin.
