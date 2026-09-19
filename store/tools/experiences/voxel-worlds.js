let worldDirty = true;
let world,
  player,
  targetBlock,
  gl,
  program,
  worldBuffer,
  worldVertexCount = 0,
  lineBuffer,
  keys = {},
  selected = 8,
  overview = false,
  cycling = false,
  timeOfDay = 0.32,
  lastWorldTime = 0,
  worldAccum = 0,
  drag = null,
  edited = 0;
const canvas = $("#world");
function shader(type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function initGL() {
  gl = canvas.getContext("webgl", {
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  if (!gl)
    throw new Error(
      "This world needs WebGL. Enable hardware acceleration or try another browser.",
    );
  program = gl.createProgram();
  gl.attachShader(
    program,
    shader(
      gl.VERTEX_SHADER,
      `attribute vec3 position;attribute vec3 color;attribute vec3 normal;attribute vec2 uv;uniform vec3 eye;uniform vec3 right;uniform vec3 up;uniform vec3 forward;uniform float aspect;varying vec3 vColor;varying vec2 vUV;varying float distance;varying float light;void main(){vec3 p=position-eye;float z=dot(p,forward);gl_Position=vec4(dot(p,right)*1.4/aspect,dot(p,up)*1.4,1.0005*z-.100025,z);vColor=color;vUV=uv;distance=length(p);light=.65+max(0.,dot(normal,normalize(vec3(-.4,.9,.3))))*.35;}`,
    ),
  );
  gl.attachShader(
    program,
    shader(
      gl.FRAGMENT_SHADER,
      `precision mediump float;varying vec3 vColor;varying vec2 vUV;varying float distance;varying float light;uniform vec3 sky;uniform float day;void main(){vec2 pixel=floor(vUV*12.);float grain=fract(sin(dot(pixel,vec2(12.9898,78.233)))*43758.5453);float edge=step(.04,fract(vUV.x))*step(.04,fract(vUV.y));if(vColor.b>vColor.r*1.5){grain=.6;edge=1.;}vec3 c=vColor*(.86+grain*.2)*light*(.25+day*.75)*(.88+.12*edge);gl_FragColor=vec4(mix(c,sky,smoothstep(35.,150.,distance)*.65),1.);}`,
    ),
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  worldBuffer = gl.createBuffer();
  lineBuffer = gl.createBuffer();
}
const faces = [
  {
    n: [1, 0, 0],
    v: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
  },
  {
    n: [-1, 0, 0],
    v: [
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
      [0, 0, 0],
    ],
  },
  {
    n: [0, 1, 0],
    v: [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
  },
  {
    n: [0, -1, 0],
    v: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
  {
    n: [0, 0, 1],
    v: [
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
      [0, 0, 1],
    ],
  },
  {
    n: [0, 0, -1],
    v: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
  },
];
function meshWorld() {
  const data = [],
    uvs = [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ];
  for (let y = 0; y < world.h; y++)
    for (let z = 0; z < world.d; z++)
      for (let x = 0; x < world.w; x++) {
        const id = blockAt(world, x, y, z);
        if (!id) continue;
        for (const face of faces) {
          const [nx, ny, nz] = face.n,
            next = blockAt(world, x + nx, y + ny, z + nz);
          if (next && (id === 7 || next !== 7)) continue;
          let color = blockTypes[id].color;
          if (id === 1 && ny === 0) color = [0.43, 0.43, 0.25];
          if (id === 7 && ny < 1) continue;
          for (const i of [0, 1, 2, 0, 2, 3])
            data.push(
              x + face.v[i][0],
              y + face.v[i][1],
              z + face.v[i][2],
              ...color,
              ...face.n,
              ...uvs[i],
            );
        }
      }
  for (const [x1, z1, x2, z2] of [
    [-160, -160, 208, 0],
    [-160, 48, 208, 208],
    [-160, 0, 0, 48],
    [48, 0, 208, 48],
  ]) {
    const vertices = [
      [x1, 6, z1],
      [x2, 6, z1],
      [x2, 6, z2],
      [x1, 6, z2],
    ];
    for (const i of [0, 1, 2, 0, 2, 3])
      data.push(
        ...vertices[i],
        0.24,
        0.52,
        0.59,
        0,
        1,
        0,
        vertices[i][0],
        vertices[i][2],
      );
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, worldBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  worldVertexCount = data.length / 11;
}
function bindVertices(buffer) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (const [name, size, offset] of [
    ["position", 3, 0],
    ["color", 3, 3],
    ["normal", 3, 6],
    ["uv", 2, 9],
  ]) {
    const loc = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 44, offset * 4);
  }
}
function drawWorld() {
  if (!gl || !world) return;
  const w = canvas.width,
    h = canvas.height;
  gl.viewport(0, 0, w, h);
  const daylight = 0.25 + 0.75 * Math.max(0, Math.sin(timeOfDay * Math.PI * 2)),
    sky = [
      lerp(0.075, 0.64, daylight),
      lerp(0.12, 0.76, daylight),
      lerp(0.19, 0.76, daylight),
    ];
  canvas.style.background = `radial-gradient(circle at 72% 20%,rgba(255,239,182,${daylight}) 0 3%,transparent 3.2%),linear-gradient(180deg,rgb(${sky.map((n) => Math.round(n * 180)).join(",")}),rgb(${sky.map((n) => Math.round(n * 255)).join(",")}) 65%)`;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const camera = overview
    ? { x: 57, y: 36, z: 62, yaw: -2.4, pitch: -0.53 }
    : { ...player, y: player.y + 1.6 };
  const { yaw, pitch } = camera,
    forward = [
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    ],
    right = [Math.cos(yaw), 0, -Math.sin(yaw)],
    up = [
      -Math.sin(yaw) * Math.sin(pitch),
      Math.cos(pitch),
      -Math.cos(yaw) * Math.sin(pitch),
    ];
  for (const [name, value] of [
    ["eye", [camera.x, camera.y, camera.z]],
    ["forward", forward],
    ["right", right],
    ["up", up],
    ["sky", sky],
  ])
    gl.uniform3fv(gl.getUniformLocation(program, name), value);
  gl.uniform1f(gl.getUniformLocation(program, "aspect"), w / h);
  gl.uniform1f(gl.getUniformLocation(program, "day"), daylight);
  bindVertices(worldBuffer);
  gl.drawArrays(gl.TRIANGLES, 0, worldVertexCount);
  targetBlock = overview
    ? null
    : raycastWorld(
        world,
        { x: camera.x, y: camera.y, z: camera.z },
        { x: forward[0], y: forward[1], z: forward[2] },
      );
  if (targetBlock) {
    const { x, y, z } = targetBlock,
      data = [],
      corners = [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ];
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 4],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ])
      for (const i of [a, b])
        data.push(
          x + corners[i][0] * 1.004 - 0.002,
          y + corners[i][1] * 1.004 - 0.002,
          z + corners[i][2] * 1.004 - 0.002,
          1,
          1,
          0.78,
          0,
          1,
          0,
          0.5,
          0.5,
        );
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    bindVertices(lineBuffer);
    gl.drawArrays(gl.LINES, 0, data.length / 11);
  }
  $("#target").textContent = overview
    ? "An island shaped by your seed. Return to the trail to build."
    : targetBlock
      ? `${blockTypes[targetBlock.id].name} · ${targetBlock.distance.toFixed(1)} m · left click breaks / right click places`
      : "Click to look · WASD to walk · Space to jump · drag to look on touch";
  $("#coordinates").textContent =
    `${player.x.toFixed(1)} / ${player.y.toFixed(1)} / ${player.z.toFixed(1)} · ${edited} edits`;
  const hour = Math.floor(timeOfDay * 24);
  $("#world-clock").textContent =
    `${String(hour).padStart(2, "0")}:${String(Math.floor(timeOfDay * 24 * 60) % 60).padStart(2, "0")} · island ${seed.slice(0, 14)}`;
}
let clickAudio;
function blockClick() {
  try {
    clickAudio ??= new (window.AudioContext || window.webkitAudioContext)();
    clickAudio.resume();
    const o = clickAudio.createOscillator(),
      g = clickAudio.createGain();
    o.type = "triangle";
    o.frequency.value = selected === 9 ? 660 : 180;
    g.gain.setValueAtTime(0.07, clickAudio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, clickAudio.currentTime + 0.075);
    o.connect(g).connect(clickAudio.destination);
    o.start();
    o.stop(clickAudio.currentTime + 0.08);
  } catch {}
}
function editBlock(place) {
  if (!targetBlock) return toast("Look at a nearby block first.");
  const p = place ? targetBlock.previous : targetBlock;
  if (!p || p.y < 1) return toast("The foundation stays in place.");
  if (
    place &&
    Math.abs(p.x + 0.5 - player.x) < 0.75 &&
    Math.abs(p.z + 0.5 - player.z) < 0.75 &&
    p.y < player.y + 1.8 &&
    p.y + 1 > player.y
  )
    return toast("Step back a little before placing that block.");
  if (putBlock(world, p.x, p.y, p.z, place ? selected : 0)) {
    edited++;
    meshWorld();
    blockClick();
    drawWorld();
  }
}
function newWorld() {
  world = voxelWorld(seed);
  player = { ...world.spawn, vy: 0, grounded: true };
  edited = 0;
  meshWorld();
  drawWorld();
}
for (const [id, i] of [1, 3, 5, 8, 9].map((id, i) => [id, i])) {
  const b = document.createElement("button");
  b.setAttribute("aria-label", blockTypes[id].name);
  b.title = `${i + 1}: ${blockTypes[id].name}`;
  b.setAttribute("aria-pressed", selected === id);
  const sw = document.createElement("i");
  sw.style.background = `rgb(${blockTypes[id].color.map((n) => Math.round(n * 255)).join(",")})`;
  b.append(sw, document.createTextNode(blockTypes[id].name));
  b.onclick = () => {
    selected = id;
    $$("#hotbar button").forEach((button, j) =>
      button.setAttribute("aria-pressed", j === i),
    );
  };
  $("#hotbar").append(b);
}
$("#break").onclick = () => editBlock(false);
$("#place").onclick = () => editBlock(true);
$("#overview").onclick = () => {
  overview = !overview;
  document.body.classList.toggle("overview", overview);
  $("#overview").textContent = overview
    ? "Back to the trail"
    : "Island overview";
  document.exitPointerLock?.();
  drawWorld();
};
$("#home").onclick = () => {
  player = { ...world.spawn, vy: 0, grounded: true };
  overview = false;
  document.body.classList.remove("overview");
  $("#overview").textContent = "Island overview";
  drawWorld();
};
$("#daylight").oninput = () => {
  timeOfDay = +$("#daylight").value / 100;
  drawWorld();
};
$("#cycle").onclick = () => {
  cycling = !cycling;
  $("#cycle").setAttribute("aria-pressed", cycling);
};
$("#export-world").onclick = () =>
  saveFile(
    `tidelands-${hash(seed)}.json`,
    JSON.stringify({
      format: "tidelands-1",
      seed,
      size: [world.w, world.h, world.d],
      blocks: Array.from(world.blocks),
      player,
      timeOfDay,
    }),
  );
canvas.oncontextmenu = (e) => e.preventDefault();
canvas.onpointerdown = (e) => {
  canvas.focus();
  if (overview) return;
  if (document.pointerLockElement === canvas) {
    editBlock(e.button === 2);
    return;
  }
  drag = { x: e.clientX, y: e.clientY };
  if (e.pointerType === "mouse")
    canvas.requestPointerLock?.()?.catch?.(() => toast("Drag to look around."));
  else canvas.setPointerCapture(e.pointerId);
};
canvas.onpointerup = canvas.onpointercancel = () => {
  drag = null;
};
addEventListener("pointerup", () => {
  drag = null;
});
document.addEventListener("pointerlockchange", () => {
  drag = null;
});
canvas.onpointermove = (e) => {
  if (overview) return;
  let dx = 0,
    dy = 0;
  if (document.pointerLockElement === canvas) {
    dx = e.movementX;
    dy = e.movementY;
  } else if (drag) {
    dx = e.clientX - drag.x;
    dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
  }
  if (dx || dy) worldDirty = true;
  player.yaw += dx * 0.004;
  player.pitch = clamp(player.pitch - dy * 0.004, -1.3, 1.3);
};
addEventListener("keydown", (e) => {
  if (editable(e.target)) return;
  const key = e.key.toLowerCase();
  if (
    [
      "w",
      "a",
      "s",
      "d",
      " ",
      "shift",
      "arrowup",
      "arrowdown",
      "arrowleft",
      "arrowright",
    ].includes(key)
  ) {
    e.preventDefault();
    keys[key] = true;
  }
  if (/^[1-5]$/.test(key)) $$("#hotbar button")[+key - 1].click();
});
addEventListener("keyup", (e) => {
  keys[e.key.toLowerCase()] = false;
});
addEventListener("blur", () => {
  keys = {};
  drag = null;
});
$$(".world-pad button").forEach((b) => {
  b.onpointerdown = (e) => {
    e.preventDefault();
    keys[b.dataset.key] = true;
    b.setPointerCapture(e.pointerId);
  };
  b.onpointerup = b.onpointercancel = () => {
    keys[b.dataset.key] = false;
  };
});
function worldFrame(time) {
  const delta = Math.min(0.1, (time - lastWorldTime) / 1000 || 0);
  lastWorldTime = time;
  if (!document.hidden) {
    const before = { x: player.x, y: player.y, z: player.z };
    if (!overview) {
      worldAccum += delta;
      while (worldAccum >= 1 / 60) {
        player = movePlayer(world, player, {
          forward:
            (keys.w || keys.arrowup ? 1 : 0) -
            (keys.s || keys.arrowdown ? 1 : 0),
          right:
            (keys.d || keys.arrowright ? 1 : 0) -
            (keys.a || keys.arrowleft ? 1 : 0),
          jump: keys[" "],
          sprint: keys.shift,
        });
        worldAccum -= 1 / 60;
      }
    }
    if (cycling) {
      timeOfDay = (timeOfDay + delta / 240) % 1;
      $("#daylight").value = timeOfDay * 100;
    }
    if (
      worldDirty ||
      cycling ||
      Math.hypot(
        player.x - before.x,
        player.y - before.y,
        player.z - before.z,
      ) > 0.0001
    ) {
      drawWorld();
      worldDirty = false;
    }
  }
  requestAnimationFrame(worldFrame);
}
try {
  initGL();
  newWorld();
  fitCanvas(canvas, drawWorld, 1.5);
  addEventListener("seedchange", newWorld);
  requestAnimationFrame(worldFrame);
  ready();
} catch (error) {
  $("#world-error").hidden = false;
  $("#world-error").textContent = error.message;
  parentMessage({ type: "harness:error", message: error.message });
}

$("#import-world").onclick = () => $("#world-file").click();
$("#world-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024)
      throw new Error("Choose a Tidelands JSON file smaller than 2 MiB.");
    const restored = importWorld(JSON.parse(await file.text()));
    setSeed(restored.world.seed);
    world = restored.world;
    player = restored.player;
    timeOfDay = restored.timeOfDay;
    $("#daylight").value = timeOfDay * 100;
    edited = 0;
    meshWorld();
    drawWorld();
    toast("Your world is restored.");
  } catch (error) {
    toast(error.message);
  } finally {
    e.target.value = "";
  }
};
