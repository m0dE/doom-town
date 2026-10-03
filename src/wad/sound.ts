// DMX digital sound lumps (DS*): u16 format (3), u16 rate, u32 sample count, then
// 8-bit unsigned PCM with 16 padding bytes at each end.

export interface PcmSound { rate: number; samples: Float32Array }

export function decodeDmx(lump: Uint8Array): PcmSound | null {
  if (lump.length < 8) return null;
  const dv = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
  if (dv.getUint16(0, true) !== 3) return null;
  const rate = dv.getUint16(2, true) || 11025;
  let count = dv.getUint32(4, true);
  let start = 8;
  if (count > lump.length - 8) count = lump.length - 8;
  // DMX pads 16 bytes before and after the samples (counted in `count`)
  if (count > 32) { start += 16; count -= 32; }
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = (lump[start + i] - 128) / 128;
  return { rate, samples };
}
