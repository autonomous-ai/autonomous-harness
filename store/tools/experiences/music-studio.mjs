import { random, pick, clamp } from "./core.mjs";
export const trackNames = ["Kick", "Snare", "Hi-hat", "Bass", "Keys"];
export function musicScore(seed) {
  const rhythm = random(seed, "rhythm"),
    melody = random(seed, "melody"),
    harmony = random(seed, "harmony");
  const root = pick([45, 48, 50, 52], harmony),
    scale = [0, 3, 5, 7, 10];
  const patterns = [
    Array.from(
      { length: 16 },
      (_, i) => i % 4 === 0 || (i === 14 && rhythm() > 0.5),
    ),
    Array.from({ length: 16 }, (_, i) => i === 4 || i === 12),
    Array.from({ length: 16 }, (_, i) => i % 2 === 0 || rhythm() > 0.64),
    Array.from({ length: 16 }, (_, i) => [0, 6, 8, 14].includes(i)),
    Array.from({ length: 16 }, (_, i) => i % 2 === 0 && melody() > 0.18),
  ];
  return {
    seed: String(seed),
    root,
    tempo: pick([82, 86, 90, 94], harmony),
    bars: 8,
    patterns,
    notes: Array.from({ length: 16 }, () => root + 24 + pick(scale, melody)),
    chords: [0, 0, 5, 5, 3, 3, 7, 0],
  };
}
export function scoreEvents(
  score,
  {
    tempo = score.tempo,
    swing = 16,
    patterns = score.patterns,
    muted = [],
  } = {},
) {
  const beat = 60 / tempo,
    step = beat / 4,
    events = [];
  for (let bar = 0; bar < score.bars; bar++)
    for (let tick = 0; tick < 16; tick++)
      for (let track = 0; track < 5; track++) {
        if (
          !patterns[track][tick] ||
          muted[track] ||
          (bar === 0 && track === 1) ||
          (bar === 7 && tick > 11 && track < 3)
        )
          continue;
        const time =
          (bar * 16 + tick) * step + (tick % 2 ? (step * swing) / 100 : 0);
        events.push({
          track,
          time,
          note:
            track === 3
              ? score.root - 12 + score.chords[bar]
              : score.notes[tick] + score.chords[bar],
          duration:
            track === 4 ? beat * 1.1 : track === 3 ? beat * 0.7 : beat * 0.35,
          bar,
          tick,
        });
      }
  return { events, duration: score.bars * 4 * beat + 1, beat };
}
export function renderMusic(score, options = {}, sampleRate = 22050) {
  const { events, duration } = scoreEvents(score, options),
    samples = new Float32Array(Math.ceil(duration * sampleRate));
  const levels = options.levels ?? [0.85, 0.5, 0.32, 0.6, 0.5];
  for (const event of events) {
    const { track, time, note } = event,
      start = Math.round(time * sampleRate),
      length = Math.min(
        samples.length - start,
        Math.ceil((track < 3 ? 0.24 : event.duration + 0.3) * sampleRate),
      );
    const frequency = 440 * 2 ** ((note - 69) / 12),
      noise = random(score.seed, `hit:${track}:${event.bar}:${event.tick}`);
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      let value = 0;
      if (track === 0) {
        phase += (2 * Math.PI * (48 + 125 * Math.exp(-t * 38))) / sampleRate;
        value = Math.sin(phase) * Math.exp(-t * 18) * 0.8;
      }
      if (track === 1)
        value =
          ((noise() * 2 - 1) * 0.66 + Math.sin(2 * Math.PI * 180 * t) * 0.34) *
          Math.exp(-t * 23) *
          0.55;
      if (track === 2) value = (noise() * 2 - 1) * Math.exp(-t * 75) * 0.27;
      if (track === 3)
        value =
          (Math.sin(2 * Math.PI * frequency * t) +
            0.18 * Math.sin(4 * Math.PI * frequency * t)) *
          Math.min(1, t * 90) *
          Math.exp(-t * 5) *
          0.5;
      if (track === 4)
        value =
          (Math.sin(2 * Math.PI * frequency * t) * 0.6 +
            Math.sin(2 * Math.PI * frequency * 2.002 * t) * 0.15 +
            Math.sin(2 * Math.PI * frequency * 0.5 * t) * 0.25) *
          Math.min(1, t * 120) *
          Math.exp(-t * 3.8) *
          0.4;
      samples[start + i] += value * levels[track];
    }
  }
  // Fixed soft ceiling, no seed-dependent normalization pumping. Leave headroom for playback.
  let peak = 0,
    energy = 0;
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.tanh(samples[i] * 1.25) * 0.9;
    peak = Math.max(peak, Math.abs(samples[i]));
    energy += samples[i] ** 2;
  }
  return {
    samples,
    sampleRate,
    duration,
    peak,
    rms: Math.sqrt(energy / samples.length),
  };
}
export function wavFile(samples, sampleRate) {
  const out = new ArrayBuffer(44 + samples.length * 2),
    v = new DataView(out);
  const text = (offset, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) =>
    v.setInt16(44 + i * 2, Math.round(clamp(s, -1, 1) * 32767), true),
  );
  return out;
}
