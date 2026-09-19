let artwork, paletteOverride;
function drawArt(canvas, model) {
  const ctx = canvas.getContext("2d"),
    p = artPalettes[model.palette];
  ctx.setTransform(canvas.width / 1000, 0, 0, canvas.height / 1250, 0, 0);
  ctx.fillStyle = p.paper;
  ctx.fillRect(0, 0, 1000, 1250);
  const paths = artPaths(model),
    colors = random(model.seed, "line-colors");
  // Batch by ink color. Hundreds of tiny GPU submissions otherwise dominate the redraw.
  const inks = p.colors.map(() => new Path2D());
  paths.forEach((points, i) => {
    const index = Math.floor(
      (((i / paths.length) * 3 + colors() * 0.45) % 1) * p.colors.length,
    );
    points.forEach(([x, y], j) =>
      j ? inks[index].lineTo(x, y) : inks[index].moveTo(x, y),
    );
  });
  ctx.lineWidth = model.mode === "dunes" ? 2.6 : 2.1;
  ctx.globalAlpha = 0.83;
  inks.forEach((path, i) => {
    ctx.strokeStyle = p.colors[i];
    ctx.stroke(path);
  });
  ctx.globalAlpha = 1;
  // Seeded paper texture in one draw, in logical coordinates at every export resolution.
  const grain = random(model.seed, "paper");
  const texture = document.createElement("canvas");
  texture.width = texture.height = 128;
  const textureContext = texture.getContext("2d");
  const pixels = textureContext.createImageData(128, 128);
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i] = model.palette === 3 ? 255 : 65;
    pixels.data[i + 1] = model.palette === 3 ? 255 : 55;
    pixels.data[i + 2] = model.palette === 3 ? 255 : 46;
    pixels.data[i + 3] = grain() > 0.91 ? 16 : 0;
  }
  textureContext.putImageData(pixels, 0, 0);
  ctx.fillStyle = ctx.createPattern(texture, "repeat");
  ctx.fillRect(0, 0, 1000, 1250);
  ctx.fillStyle = p.colors[0];
  ctx.font = "9px monospace";
  ctx.fillText(
    `FIELDWORK   /   ${model.seed.slice(0, 26)}   /   ${model.mode.toUpperCase()}`,
    70,
    1208,
  );
}
function controls() {
  return {
    density: +$("#density").value,
    curl: +$("#curl").value,
    mode: $("#mode").value,
    palette: paletteOverride,
  };
}
function renderArt() {
  artwork = artModel(seed, controls());
  $("#density-value").value = artwork.density;
  $("#curl-value").value = artwork.curl;
  $("#edition").textContent = seed;
  $("#palette-name").textContent = artPalettes[artwork.palette].name;
  drawArt($("#art"), artwork);
  $$("#palettes button").forEach((b, i) =>
    b.setAttribute("aria-pressed", i === artwork.palette),
  );
  $("#editions").replaceChildren();
  for (let i = 1; i <= 3; i++) {
    const next = /^\d{1,9}$/.test(seed) ? String(+seed + i) : `${seed}.${i}`;
    const button = document.createElement("button"),
      c = document.createElement("canvas"),
      label = document.createElement("span");
    c.width = 160;
    c.height = 200;
    label.textContent = next.slice(0, 9);
    button.setAttribute("aria-label", `Explore seed ${next}`);
    button.append(c, label);
    button.onclick = () => setSeed(next);
    $("#editions").append(button);
    drawArt(c, artModel(next, controls()));
  }
}
artPalettes.forEach((p, i) => {
  const b = document.createElement("button");
  b.title = p.name;
  b.setAttribute("aria-label", p.name);
  b.style.background = `conic-gradient(${p.colors.map((c, j) => `${c} ${j * 20}% ${(j + 1) * 20}%`).join(",")})`;
  b.onclick = () => {
    paletteOverride = i;
    renderArt();
  };
  $("#palettes").append(b);
});
$("#art").width = 1000;
$("#art").height = 1250;
for (const id of ["density", "curl", "mode"])
  $("#" + id).addEventListener("input", renderArt);
$("#export").onclick = () => {
  const c = document.createElement("canvas");
  c.width = +$("#export-size").value;
  c.height = c.width * 1.25;
  drawArt(c, artwork);
  canvasPNG(c, `fieldwork-${hash(seed)}-${artwork.mode}.png`);
  toast("Your print is ready.");
};
addEventListener("seedchange", renderArt);
renderArt();
ready();
