// Lighting without files: every environment here is a small scene rendered into a PMREM once, and
// the matcap is painted on a canvas. Nothing is fetched — the pane works offline.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

/** A sky dome whose colour runs from `bottom` through `horizon` to `top`, as a BackSide sphere. */
function dome(top, horizon, bottom, power = 1) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color(...top) }, horizon: { value: new THREE.Color(...horizon) }, bottom: { value: new THREE.Color(...bottom) }, power: { value: power } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform float power; varying vec3 vDir;
      void main() { float y = vDir.y; vec3 c = y > 0.0 ? mix(horizon, top, pow(y, power)) : mix(horizon, bottom, pow(-y, 0.6));
      gl_FragColor = vec4(c, 1.0); }`,
  })
  return new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), material)
}

function panel(scene, { w, h, at, look, color, strength }) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(...color).multiplyScalar(strength), side: THREE.DoubleSide }))
  mesh.position.set(...at)
  mesh.lookAt(...look)
  scene.add(mesh)
}

const BUILDERS = {
  studio: () => new RoomEnvironment(),
  soft: () => {
    const s = new THREE.Scene()
    s.add(dome([1.0, 1.0, 1.0], [0.82, 0.82, 0.84], [0.35, 0.34, 0.33], 0.7))
    panel(s, { w: 30, h: 30, at: [0, 30, 0], look: [0, 0, 0], color: [1, 1, 1], strength: 2.2 })
    panel(s, { w: 16, h: 10, at: [-26, 8, 14], look: [0, 0, 0], color: [1, 0.98, 0.95], strength: 1.4 })
    return s
  },
  sunset: () => {
    const s = new THREE.Scene()
    s.add(dome([0.32, 0.45, 0.78], [1.0, 0.62, 0.36], [0.16, 0.11, 0.09], 0.45))
    const sun = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.72, 0.42).multiplyScalar(40) }))
    sun.position.set(-30, 7, -26)
    s.add(sun)
    panel(s, { w: 20, h: 12, at: [28, 16, 20], look: [0, 0, 0], color: [0.6, 0.72, 1], strength: 0.9 })
    return s
  },
  night: () => {
    const s = new THREE.Scene()
    s.add(dome([0.03, 0.04, 0.08], [0.09, 0.1, 0.16], [0.02, 0.02, 0.03], 0.8))
    panel(s, { w: 6, h: 26, at: [-24, 8, -16], look: [0, 0, 0], color: [0.55, 0.7, 1], strength: 5 })
    panel(s, { w: 6, h: 26, at: [24, 8, -16], look: [0, 0, 0], color: [1, 0.55, 0.35], strength: 4 })
    panel(s, { w: 18, h: 10, at: [0, 22, 22], look: [0, 0, 0], color: [1, 1, 1], strength: 1.2 })
    return s
  },
}

export const ENVIRONMENTS = [
  { id: 'studio', name: 'Studio' },
  { id: 'soft', name: 'Soft box' },
  { id: 'sunset', name: 'Sunset' },
  { id: 'night', name: 'Night rim' },
]

export class Environments {
  constructor(renderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.cache = new Map()
  }

  get(id) {
    if (!BUILDERS[id]) id = 'studio'
    if (!this.cache.has(id)) {
      const source = BUILDERS[id]()
      const target = this.pmrem.fromScene(source, id === 'studio' ? 0.04 : 0.02)
      source.traverse?.((o) => { o.geometry?.dispose(); o.material?.dispose?.() })
      this.cache.set(id, target.texture)
    }
    return this.cache.get(id)
  }
}

// Backgrounds are CSS behind a transparent canvas: exact colours, no tone mapping, cheap to change.
export const BACKGROUNDS = [
  { id: 'light', name: 'Light', css: 'radial-gradient(120% 90% at 50% 38%, #fbfbfa 0%, #efefec 55%, #e2e2de 100%)', dark: false, swatch: '#ececea' },
  { id: 'dark', name: 'Blender', css: 'linear-gradient(180deg, #474747 0%, #3a3a3a 55%, #2f2f2f 100%)', dark: true, swatch: '#3d3d3d' },
  { id: 'white', name: 'White', css: '#ffffff', dark: false, swatch: '#ffffff' },
  { id: 'black', name: 'Black', css: 'radial-gradient(120% 90% at 50% 40%, #232326 0%, #141416 70%, #0c0c0d 100%)', dark: true, swatch: '#141416' },
  { id: 'world', name: 'World', css: '#808080', dark: true, swatch: 'linear-gradient(180deg,#9fb6d9,#e7b58a)' },
]

/** A clay matcap, painted: soft key from the upper left, a floor bounce, a rim. */
export function clayMatcap() {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')
  const r = size / 2
  const image = g.createImageData(size, size)
  const key = new THREE.Vector3(-0.45, 0.6, 0.66).normalize()
  const fill = new THREE.Vector3(0.6, -0.1, 0.8).normalize()
  const n = new THREE.Vector3()
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5 - r) / r, ny = -(y + 0.5 - r) / r
      const d = nx * nx + ny * ny
      const i = (y * size + x) * 4
      if (d > 1) { image.data[i + 3] = 255; continue }
      n.set(nx, ny, Math.sqrt(1 - d))
      const diffuse = Math.max(0, n.dot(key))
      const wrap = Math.max(0, (n.dot(fill) + 0.4) / 1.4)
      const bounce = Math.max(0, -ny) * 0.12
      const spec = Math.pow(Math.max(0, n.clone().add(new THREE.Vector3(0, 0, 1)).normalize().dot(key)), 40) * 0.45
      const rim = Math.pow(1 - n.z, 3) * 0.22
      const v = 0.16 + diffuse * 0.68 + wrap * 0.2 + bounce + rim
      image.data[i] = Math.min(255, (v + spec) * 236)
      image.data[i + 1] = Math.min(255, (v + spec) * 234)
      image.data[i + 2] = Math.min(255, (v + spec) * 230)
      image.data[i + 3] = 255
    }
  }
  g.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
