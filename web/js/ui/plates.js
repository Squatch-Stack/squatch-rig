// Pedal plates: the owner-approved pedal art (design/assets/plates, byte copies of Rig Live's
// ui/art/pedals; SOURCE.json records where they came from) drawn as the device body.
//
// A plate is the art panel of the Brush pedal face (squatch-skin `form:3-knob`, 66 x 122 mm): its
// viewBox is `4 12 58 99` in face millimetres, and every plate draws the glyph window, the lamp ring
// and the footswitch ring at the same face positions. So a plated device is composed here as one
// SVG in face millimetres: the lacquered face, the plate in its panel, the nameplate band, and the
// invisible anchor slots (design/DIRECTION.md, "The anchor contract") at the positions the plate
// already draws, so the canvas puts its live knobs, glyph, lamp and footswitch on the plate's own
// rings. The plate itself is never changed: only its colour classes (f-ink, s-paper, ...) become
// attributes, because a detached SVG image has no stylesheet (Rig Live's docs/PEDAL-ART.md, "Colours").
//
// On by default. ?pedalart=0 turns the plates off (remembered), ?pedalart=1 turns them back on, as in Rig Live.

/** Face geometry in millimetres (squatch-skin Brush `form:3-knob`, and the rings every plate draws). */
export const FACE = {
  w: 66, h: 122, radius: 4.5,
  art: { x: 4, y: 12, w: 58, h: 99 },
  knobY: 21, knobD: 16,
  window: { x: 14.64, y: 61.23, w: 36.72, h: 19.52 },
  lamp: { x: 33, y: 90, d: 6 },
  footswitch: { x: 33, y: 104, d: 14 },
  nameplate: { x: 6, y: 113, w: 54, h: 7 },
  jackY: 30,
};

/** Knob centres along the row for n knobs (Rig Live's faceLayout: one in the middle, two a knob and a half either side, three on the skin's slots). */
export function knobXs(n) {
  if (n <= 0) return [];
  if (n === 1) return [33];
  if (n === 2) return [18, 48];
  return [13, 33, 53];
}

/** squatch-skin lacquer bands (tokens --sq-comp-lacquer-<kind>-band, light and dark), as Rig Live uses them. */
export const LACQUER = {
  gate: { light: '#53749D', dark: '#6A8BB6' },
  comp: { light: '#387E82', dark: '#4E9397' },
  amp: { light: '#906B00', dark: '#BF9840' },
  cab: { light: '#8D6949', dark: '#A68160' },
  hall: { light: '#7C6695', dark: '#957FB0' },
  limiter: { light: '#9A2E1B', dark: '#D9553D' },
  od: { light: '#667A41', dark: '#7C9157' },
};
const FACE_BASE = { light: '#F7F5F0', dark: '#17130D' }; // --sq-comp-pedal-face
/** Text on a lacquer band (--sq-comp-lacquer-on-band), as numbers for the canvas. */
export const ON_BAND = { light: 0xFFFFFF, dark: 0x17130D };

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
/** color-mix(in srgb, a p%, b) */
export function mix(a, p, b) {
  const A = hex(a), B = hex(b);
  return `#${A.map((v, i) => Math.round(v * p + B[i] * (1 - p)).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** The plate's colours in one theme: the face tinted 13% by the lacquer, ink and accent from the canvas theme. */
export function plateColours(lacquer, themeName, css) {
  const band = LACQUER[lacquer]?.[themeName] ?? null;
  const face = band ? mix(band, 0.13, FACE_BASE[themeName]) : FACE_BASE[themeName];
  const ink = css.ink.trim(), sun = css.accent.trim();
  return { face, paper: face, ink, sun, band: band ?? mix(ink, 0.45, face), lacquer: band ?? mix(ink, 0.45, face), lacquer2: mix(ink, 0.38, face) };
}

const CLASS_ATTR = { f: 'fill', s: 'stroke', stop: 'stop-color' };
const ROLE = { paper: 'paper', ink: 'ink', lacquer: 'lacquer', lacquer2: 'lacquer2', sun: 'sun' };

/** The plate's colour classes as attributes (`class="f-paper s-ink"` -> `fill="#.." stroke="#.."`); unknown classes are kept. */
export function inlineClasses(svgText, colours) {
  return svgText.replace(/\sclass="([^"]*)"/g, (whole, list) => {
    const keep = [], attrs = [];
    for (const c of list.split(/\s+/).filter(Boolean)) {
      const m = /^(f|s|stop)-([a-z0-9]+)$/.exec(c);
      const role = m && ROLE[m[2]];
      if (role) attrs.push(`${CLASS_ATTR[m[1]]}="${colours[role]}"`);
      else keep.push(c);
    }
    return (keep.length ? ` class="${keep.join(' ')}"` : '') + (attrs.length ? ` ${attrs.join(' ')}` : '');
  });
}

/** The plate's inner markup (everything inside its root <svg>). */
function inner(plateText) {
  const open = plateText.indexOf('>', plateText.indexOf('<svg'));
  const close = plateText.lastIndexOf('</svg>');
  return plateText.slice(open + 1, close);
}

/**
 * One themed device SVG in face millimetres: face, plate, nameplate band, and the anchor slots.
 * `knobs` is how many knobs the node shows (at most three fit the row); `ins`/`outs` the jack counts.
 */
export function composePlate(plateText, { colours, knobs = 0, ins = 1, outs = 1, footswitch = true }) {
  const F = FACE, ring = (s, cls) => `<circle data-slot="${cls}" cx="${s.x}" cy="${s.y}" r="${s.d / 2}" fill="none"/>`;
  const slots = [
    ...knobXs(Math.min(knobs, 3)).map((x, i) => `<circle data-slot="knob" data-i="${i}" cx="${x}" cy="${F.knobY}" r="${F.knobD / 2}" fill="none"/>`),
    `<rect data-slot="glyph" x="${F.window.x}" y="${F.window.y}" width="${F.window.w}" height="${F.window.h}" fill="none"/>`,
    ring(F.lamp, 'led'),
    footswitch ? ring(F.footswitch, 'footswitch') : '',
    ...Array.from({ length: ins }, (_, i) => `<circle data-slot="jack-in${ins > 1 ? `-${'abcd'[i]}` : ''}" cx="0" cy="${F.jackY + i * 12}" r="2.6" fill="none"/>`),
    ...Array.from({ length: outs }, (_, i) => `<circle data-slot="jack-out${outs > 1 ? `-${'abcd'[i]}` : ''}" cx="${F.w}" cy="${F.jackY + i * 12}" r="2.6" fill="none"/>`),
  ].join('');
  const N = F.nameplate, A = F.art;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${F.w} ${F.h}" width="${F.w}" height="${F.h}">`
    + `<rect x="0.3" y="0.3" width="${F.w - 0.6}" height="${F.h - 0.6}" rx="${F.radius}" fill="${colours.face}" stroke="${colours.ink}" stroke-opacity="0.35" stroke-width="0.6"/>`
    + `<svg x="${A.x}" y="${A.y}" width="${A.w}" height="${A.h}" viewBox="${A.x} ${A.y} ${A.w} ${A.h}">${inlineClasses(inner(plateText), colours)}</svg>`
    + `<rect x="${N.x}" y="${N.y}" width="${N.w}" height="${N.h}" rx="1" fill="${colours.band}"/>`
    + slots + '</svg>';
}

/** Whether plates are drawn: ?pedalart=0 turns them off and remembers it; ?pedalart=1 turns them on and forgets the off. */
export function pedalArtOn(params = new URLSearchParams(globalThis.location?.search ?? ''), storage = globalThis.localStorage) {
  const want = params.get('pedalart');
  try {
    if (want === '0') storage?.setItem('squatch-rig:pedalart', '0');
    if (want === '1') storage?.removeItem('squatch-rig:pedalart');
    return storage?.getItem('squatch-rig:pedalart') !== '0';
  } catch { return want !== '0'; }
}
