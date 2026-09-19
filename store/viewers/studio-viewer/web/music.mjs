// Deliberately identical to ableton-ai/toolchain/workflow.py::notes.
// A shared fixture checks the browser audition against the exported note events.
export function groove(p) {
  let slots;
  if (p.pattern) slots = [...p.pattern].flatMap((v, i) => v === '1' ? [i] : []);
  else {
    let state = p.seed;
    slots = Array.from({length:16}, (_, i) => i);
    for (let i = 15; i > 0; i--) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const j = Math.floor(state / 4294967296 * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    slots = slots.slice(0, p.density).sort((a, b) => a - b);
  }
  const scales = {minor:[0,3,5,7,10], major:[0,4,5,7,11], pentatonic:[0,2,4,7,9]};
  return slots.map(s => ({step:s, note:48+scales[p.scale][(s+p.seed)%5],
    velocity:75+(s*17+p.seed*13)%36, beat:s/4+(s%2?p.swing/4:0), length:.22}));
}
