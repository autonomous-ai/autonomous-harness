// The floor grid, Blender's way: lines drawn by a shader so they stay one pixel wide at any zoom,
// three decades of spacing that fade in and out with the size of a cell on screen, the X axis in red
// and the Y axis in green, and a soft edge instead of a horizon line.
import * as THREE from 'three'

const vertexShader = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`

const fragmentShader = /* glsl */`
  uniform float uBase;      // world units between the finest lines
  uniform vec3 uColor;
  uniform vec3 uAxisX;
  uniform vec3 uAxisY;
  uniform vec3 uCenter;
  uniform float uFade;
  uniform float uOpacity;
  varying vec3 vWorld;

  float line(vec2 p, float spacing, out float cellPx) {
    vec2 c = p / spacing;
    vec2 w = fwidth(c);
    cellPx = 1.0 / max(max(w.x, w.y), 1e-6);
    vec2 g = abs(fract(c - 0.5) - 0.5) / max(w, vec2(1e-6));
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  void main() {
    vec2 p = vWorld.xz;
    float px0, px1, px2;
    float l0 = line(p, uBase, px0);
    float l1 = line(p, uBase * 10.0, px1);
    float l2 = line(p, uBase * 100.0, px2);
    float a = 0.0;
    a = max(a, l0 * 0.16 * smoothstep(6.0, 26.0, px0));
    a = max(a, l1 * 0.3 * smoothstep(6.0, 26.0, px1));
    a = max(a, l2 * 0.42 * smoothstep(4.0, 16.0, px2));
    vec2 fw = max(fwidth(p), vec2(1e-6));
    float ax = 1.0 - min(abs(p.y) / fw.y / 1.1, 1.0);   // the X axis: z = 0
    float ay = 1.0 - min(abs(p.x) / fw.x / 1.1, 1.0);   // Blender's Y axis: x = 0 (glTF -Z)
    vec3 color = uColor;
    color = mix(color, uAxisX, ax);
    color = mix(color, uAxisY, ay * (1.0 - ax));
    a = max(a, max(ax, ay) * 0.75);
    float d = length(p - uCenter.xz);
    a *= 1.0 - smoothstep(uFade * 0.35, uFade, d);
    if (a < 0.004) discard;
    gl_FragColor = vec4(color, a * uOpacity);
  }`

export class Grid {
  constructor() {
    this.uniforms = {
      uBase: { value: 1 }, uColor: { value: new THREE.Color(0x000000) },
      uAxisX: { value: new THREE.Color(0xe0474f) }, uAxisY: { value: new THREE.Color(0x6aa82a) },
      uCenter: { value: new THREE.Vector3() }, uFade: { value: 1000 }, uOpacity: { value: 1 },
    }
    const material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false, side: THREE.DoubleSide, extensions: { derivatives: true } })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
    this.mesh.rotation.x = -Math.PI / 2
    this.mesh.renderOrder = -1
    this.mesh.frustumCulled = false
    this.mesh.name = '__grid'
    this.spacingMm = 10
  }

  setTheme(dark) {
    this.uniforms.uColor.value.set(dark ? 0xffffff : 0x1a1a18)
    this.uniforms.uOpacity.value = dark ? 0.55 : 0.5
    this.uniforms.uAxisX.value.set(dark ? 0xff5a61 : 0xd93c46)
    this.uniforms.uAxisY.value.set(dark ? 0x8fd14f : 0x5f9e22)
  }

  /** Follow the view: centred under the target, a decade of spacing chosen from the zoom. */
  update(target, worldPerPixel, extent, mmPerUnit, y = 0) {
    const size = Math.max(extent * 8, 1e-3)
    this.mesh.scale.set(size, size, 1)
    this.mesh.position.set(target.x, y, target.z)
    this.uniforms.uCenter.value.set(target.x, y, target.z)
    this.uniforms.uFade.value = extent * 1.1
    // finest decade whose cells are at least ~5 px; in millimetres, never finer than 0.01 mm
    const mmPerPixel = worldPerPixel * mmPerUnit
    const baseMm = Math.max(0.01, Math.pow(10, Math.floor(Math.log10(Math.max(mmPerPixel * 5, 1e-9)))))
    this.uniforms.uBase.value = baseMm / mmPerUnit
    // the spacing a reader sees: the finest decade drawn at a comfortable size (≥ 22 px)
    let spacing = baseMm
    while (spacing / mmPerPixel < 22) spacing *= 10
    this.spacingMm = spacing
  }
}
