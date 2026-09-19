let direction,
  directionIndex,
  lockedColors,
  customBrand = "";
function renderDirection() {
  direction = directionModel(seed, directionIndex, lockedColors);
  const name = customBrand || direction.brand;
  $("#poster").innerHTML = brandSVG(direction, name);
  $("#direction-name").textContent =
    `DIRECTION 0${direction.index + 1} / ${direction.name}`;
  $("#direction-line").textContent = direction.line;
  $("#rationale").textContent = direction.note;
  $("#brand-name").value = name;
  $("#type-specimen").style.fontFamily = direction.type;
  $("#type-name").textContent = `${direction.type} display / system sans body`;
  $("#mood").textContent = direction.mood;
  $("#swatches").replaceChildren();
  direction.colors.forEach((color) => {
    const b = document.createElement("button");
    b.style.background = color;
    b.style.color =
      contrast(color, "#ffffff") > contrast(color, "#151515")
        ? "#ffffff"
        : "#151515";
    b.textContent = color.toUpperCase();
    b.title = `Show color ${color}`;
    b.onclick = () =>
      toast(`${color.toUpperCase()} — included in your exported tokens`);
    $("#swatches").append(b);
  });
  const ratio = contrast(direction.colors[0], direction.colors[1]);
  $("#contrast").textContent =
    `Ink on paper: ${ratio.toFixed(1)}:1 contrast · ${ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : "display only"}`;
  $("#brand-card").style.background = direction.colors[0];
  $("#brand-card").style.color = direction.colors[1];
  $("#card-name").textContent = name;
  $("#card-name").style.fontFamily = direction.type;
  $$("#directions button").forEach((b, i) =>
    b.setAttribute("aria-pressed", i === direction.index),
  );
}
directions.forEach((d, i) => {
  const b = document.createElement("button");
  b.textContent = `0${i + 1} / ${d.name}`;
  b.onclick = () => {
    directionIndex = i;
    renderDirection();
  };
  $("#directions").append(b);
});
$("#brand-name").addEventListener("input", (e) => {
  customBrand = e.target.value;
  renderDirection();
});
$("#lock-palette").onclick = () => {
  lockedColors = lockedColors ? undefined : [...direction.colors];
  $("#lock-palette").setAttribute("aria-pressed", !!lockedColors);
  $("#lock-palette").textContent = lockedColors
    ? "Palette locked"
    : "Lock palette";
};
$("#tokens").onclick = () =>
  saveFile(
    `forme-${hash(seed)}.json`,
    JSON.stringify(
      {
        seed,
        brand: customBrand || direction.brand,
        direction: direction.name,
        colors: Object.fromEntries(
          ["ink", "paper", "accent", "secondary", "detail"].map((key, i) => [
            key,
            direction.colors[i],
          ]),
        ),
        typography: { display: direction.type, body: "system-ui" },
        rationale: direction.note,
      },
      null,
      2,
    ),
  );
$("#poster-export").onclick = () =>
  saveFile(
    `forme-${hash(seed)}.svg`,
    brandSVG(direction, customBrand || direction.brand),
    "image/svg+xml",
  );
addEventListener("seedchange", () => {
  directionIndex = undefined;
  renderDirection();
});
renderDirection();
ready();
