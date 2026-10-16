// Tiny WAV reader/writer for tests (PCM16/24/32, float32; mono-mixed on read).
import fs from 'node:fs';

export function readWav(path) {
  const b = fs.readFileSync(path);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(p + 8, true), ch: dv.getUint16(p + 10, true), sr: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
    if (id === 'data') data = { off: p + 8, size };
    p += 8 + size + (size & 1);
  }
  let format = fmt.format;
  if (format === 0xfffe) format = fmt.bits === 32 ? 3 : 1; // extensible: guess
  const bps = fmt.bits / 8, frames = Math.floor(data.size / (bps * fmt.ch));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = data.off + (i * fmt.ch + c) * bps;
      if (format === 3) s += dv.getFloat32(o, true);
      else if (fmt.bits === 16) s += dv.getInt16(o, true) / 32768;
      else if (fmt.bits === 24) { let v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); if (v & 0x800000) v -= 0x1000000; s += v / 8388608; }
      else if (fmt.bits === 32) s += dv.getInt32(o, true) / 2147483648;
    }
    out[i] = s / fmt.ch;
  }
  return { sampleRate: fmt.sr, data: out };
}

export function writeWavFloat(path, data, sampleRate) {
  const n = data.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) b.writeFloatLE(data[i], 44 + i * 4);
  fs.writeFileSync(path, b);
}
