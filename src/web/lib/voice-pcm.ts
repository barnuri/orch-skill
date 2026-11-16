/** PCM helpers: a recording the hub refuses is decoded in the browser and sent again as two overlapping 16 kHz wav halves. */

export const PCM_RATE = 16_000;

export function encodeWav(samples: Int16Array, rate: number = PCM_RATE): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, samples.length * 2, true);
  new Int16Array(buf, 44, samples.length).set(samples);
  return new Blob([buf], { type: "audio/wav" });
}

/** Two halves of mono samples that share `overlapMs`, so a word at the cut is whole in at least one; null when too short. */
export function halvesOf(samples: Float32Array | Int16Array, rate: number, overlapMs: number = 600, minSeconds: number = 4): [Int16Array, Int16Array] | null {
  if (samples.length < rate * minSeconds) return null;
  const toInt = (a: Float32Array | Int16Array): Int16Array => (a instanceof Int16Array ? a : Int16Array.from(a, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 0x7fff)));
  const mid = Math.floor(samples.length / 2);
  const overlap = Math.floor((rate * overlapMs) / 1000);
  return [toInt(samples.slice(0, mid + overlap)), toInt(samples.slice(Math.max(0, mid - overlap)))];
}
