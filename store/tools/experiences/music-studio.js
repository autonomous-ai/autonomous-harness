let score,
  patterns,
  rendered,
  audioContext,
  source,
  master,
  started = 0,
  offset = 0,
  playing = false,
  muted = [false, false, false, false, false],
  levels = [0.85, 0.5, 0.32, 0.6, 0.5];
const clockText = (s) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const musicOptions = () => ({
  tempo: +$("#tempo").value,
  swing: +$("#swing").value,
  patterns,
  muted,
  levels,
});
function stopMusic(reset = true) {
  if (source) {
    source.onended = null;
    source.stop();
    source = null;
  }
  if (playing && audioContext) offset = audioContext.currentTime - started;
  playing = false;
  if (reset) offset = 0;
  $("#play").textContent = "▶ Play";
  drawWave();
}
function rebuildMusic() {
  stopMusic();
  rendered = renderMusic(score, musicOptions());
  $("#tempo-value").value = `${$("#tempo").value} BPM`;
  $("#swing-value").value = `${$("#swing").value}%`;
  $("#time").textContent = `0:00 / ${clockText(rendered.duration)}`;
  $("#peak").textContent =
    `PEAK ${rendered.peak ? (20 * Math.log10(rendered.peak)).toFixed(1) : "−∞"} dBFS`;
  $("#audio-status").textContent =
    "Your score is ready. Press Play to hear it.";
  drawWave();
}
function drawWave() {
  if (!rendered) return;
  const c = $("#waveform"),
    ctx = c.getContext("2d"),
    w = c.width,
    h = c.height;
  ctx.clearRect(0, 0, w, h);
  const pos = playing ? audioContext.currentTime - started : offset;
  const played = (pos / rendered.duration) * w;
  const stride = Math.max(1, Math.floor(rendered.samples.length / w));
  ctx.lineWidth = 1.4;
  for (let x = 0; x < w; x += 3) {
    let peak = 0;
    for (
      let i = x * stride;
      i < Math.min((x + 3) * stride, rendered.samples.length);
      i += 8
    )
      peak = Math.max(peak, Math.abs(rendered.samples[i]));
    ctx.strokeStyle = x < played ? "#efb082" : "#836650";
    ctx.beginPath();
    ctx.moveTo(x, h / 2 - peak * h * 0.7);
    ctx.lineTo(x, h / 2 + peak * h * 0.7);
    ctx.stroke();
  }
  if (playing) {
    ctx.strokeStyle = "#f7e7d0";
    ctx.beginPath();
    ctx.moveTo(played, 0);
    ctx.lineTo(played, h);
    ctx.stroke();
  }
}
function renderGrid() {
  const grid = $("#steps");
  grid.replaceChildren();
  grid.append(document.createElement("span"));
  for (let i = 0; i < 16; i++) {
    const s = document.createElement("span");
    s.className = "step-num";
    s.textContent = i + 1;
    grid.append(s);
  }
  trackNames.forEach((name, track) => {
    const b = document.createElement("button");
    b.className = "track";
    b.textContent = muted[track] ? `${name} ×` : name;
    b.setAttribute("aria-label", `${muted[track] ? "Unmute" : "Mute"} ${name}`);
    b.onclick = () => {
      muted[track] = !muted[track];
      renderGrid();
      rebuildMusic();
    };
    grid.append(b);
    patterns[track].forEach((on, tick) => {
      const s = document.createElement("button");
      s.className = `step ${tick % 4 === 0 ? "beat" : ""}`;
      s.dataset.tick = tick;
      s.setAttribute("aria-pressed", on);
      s.setAttribute("aria-label", `${name} step ${tick + 1}`);
      s.onclick = () => {
        patterns[track][tick] = !patterns[track][tick];
        renderGrid();
        rebuildMusic();
      };
      grid.append(s);
    });
  });
}
async function playMusic() {
  if (playing) {
    stopMusic(false);
    return;
  }
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    master ??= audioContext.createGain();
    master.disconnect();
    master.connect(audioContext.destination);
    master.gain.value = +$("#volume").value / 100;
    const buffer = audioContext.createBuffer(
      1,
      rendered.samples.length,
      rendered.sampleRate,
    );
    buffer.copyToChannel(rendered.samples, 0);
    source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(master);
    if (offset >= rendered.duration) offset = 0;
    started = audioContext.currentTime - offset;
    source.start(0, offset);
    source.onended = () => {
      playing = false;
      source = null;
      offset = 0;
      $("#play").textContent = "▶ Play";
      $("#audio-status").textContent =
        "That was your take. Play it again, or change a step.";
    };
    playing = true;
    $("#play").textContent = "Ⅱ Pause";
    $("#audio-status").textContent = "Playing your eight-bar arrangement.";
  } catch (e) {
    toast("Audio could not start: " + e.message);
  }
}
function newScore() {
  score = musicScore(seed);
  patterns = score.patterns.map((row) => [...row]);
  $("#tempo").value = score.tempo;
  $("#key").textContent =
    ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"][
      score.root % 12
    ] + " minor";
  renderGrid();
  rebuildMusic();
}
trackNames.forEach((name, i) => {
  const label = document.createElement("label");
  label.className = "field";
  const span = document.createElement("span");
  span.textContent = name;
  const input = document.createElement("input");
  input.type = "range";
  input.min = 0;
  input.max = 100;
  input.value = levels[i] * 100;
  input.setAttribute("aria-label", `${name} level`);
  input.onchange = () => {
    levels[i] = +input.value / 100;
    rebuildMusic();
  };
  label.append(span, input);
  $("#mixer").append(label);
});
$("#play").onclick = playMusic;
$("#stop").onclick = () => {
  stopMusic();
  $("#time").textContent = `0:00 / ${clockText(rendered.duration)}`;
  $("#audio-status").textContent =
    "Stopped. Press Play to start at the beginning.";
};
for (const id of ["tempo", "swing"]) $("#" + id).onchange = rebuildMusic;
$("#volume").oninput = () => {
  $("#volume-value").value = `${$("#volume").value}%`;
  if (master)
    master.gain.setTargetAtTime(
      +$("#volume").value / 100,
      audioContext.currentTime,
      0.02,
    );
};
$("#export-wav").onclick = () => {
  saveFile(
    `afterhours-${hash(seed)}.wav`,
    wavFile(rendered.samples, rendered.sampleRate),
    "audio/wav",
  );
  toast("WAV rendered from your current score and mix.");
};
let lastTick = -1;
function musicFrame() {
  if (playing) {
    const t = Math.min(rendered.duration, audioContext.currentTime - started),
      tick = Math.floor(t / (60 / +$("#tempo").value / 4)) % 16;
    $("#time").textContent =
      `${clockText(t)} / ${clockText(rendered.duration)}`;
    $("#bar").textContent =
      `Bar ${Math.min(8, Math.floor(t / ((60 / +$("#tempo").value) * 4)) + 1)} / 8`;
    if (tick !== lastTick) {
      $$(".step").forEach((b) =>
        b.classList.toggle("current", +b.dataset.tick === tick),
      );
      lastTick = tick;
    }
    drawWave();
  } else if (lastTick !== -1) {
    $$(".step.current").forEach((b) => b.classList.remove("current"));
    lastTick = -1;
  }
  requestAnimationFrame(musicFrame);
}
fitCanvas($("#waveform"), drawWave);
addEventListener("seedchange", newScore);
addEventListener("pagehide", () => {
  stopMusic();
  audioContext?.close();
});
newScore();
musicFrame();
ready();
