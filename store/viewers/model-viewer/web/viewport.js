// The viewport: three.js drawn the way Blender's 3D view draws — Solid, Material Preview, Rendered
// and Wireframe shading, X-ray, the floor grid, orange selection outlines, a section plane with
// hatched caps, exploded views, scene cameras and the timeline. Rendered on demand: a still view
// costs nothing, so the pane can sit open beside the terminal all day.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js'
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js'
import { Navigator, Gizmo } from './nav.js'
import { Grid } from './grid.js'
import { Environments, clayMatcap } from './env.js'

// Blender axes ↔ glTF (Y-up): Blender (x, y, z) = glTF (x, −z, y)
export const toBlender = (v) => [v.x, -v.z, v.y]
export const AXIS_DIR = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 0, -1), z: new THREE.Vector3(0, 1, 0) }

const ACTIVE = new THREE.Color('#ffa21f')
const SELECTED = new THREE.Color('#f26b1d')
const CHANGED = new THREE.Color('#2f5bea')
// the outline composite works on display-referred (sRGB) pixels
const srgb = (c) => { const o = c.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace); return new THREE.Vector3(o.r, o.g, o.b) }

// Blender's outliner order: child collections first, then objects by name (numbers in natural order).
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
function sortChildren(item) {
  item.children.sort((a, b) => (b.type === 'COLLECTION') - (a.type === 'COLLECTION') || collator.compare(a.name, b.name))
}

// ---------------------------------------------------------------------------------------------------
// The section cap: back faces seen through the cut are drawn flat and hatched, so a cut reads as solid.

const capUniforms = { uCapOn: { value: 0 } }
function hookCap(material) {
  if (material.userData.capHooked) return material
  material.userData.capHooked = true
  const prior = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    prior?.call(material, shader, renderer)
    shader.uniforms.uCapOn = capUniforms.uCapOn
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uCapOn;\nvoid main() {')
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        if (uCapOn > 0.5 && !gl_FrontFacing) {
          vec3 capBase = mix(diffuseColor.rgb, vec3(0.92, 0.9, 0.86), 0.35);
          float hatch = step(mod(gl_FragCoord.x + gl_FragCoord.y, 9.0), 1.7);
          gl_FragColor = vec4(mix(capBase, capBase * 0.45, hatch), 1.0);
        }`)
  }
  const key = material.customProgramCacheKey?.bind(material)
  material.customProgramCacheKey = () => `${key ? key() : ''}|cap`
  return material
}

// ---------------------------------------------------------------------------------------------------
// Post: the outline composite reads a mask (r: selected 0.5 / active 1, g: changed, b: hovered)

const OutlineShader = {
  uniforms: {
    tDiffuse: { value: null }, tMask: { value: null }, uTexel: { value: new THREE.Vector2() },
    uActive: { value: srgb(ACTIVE) }, uSelected: { value: srgb(SELECTED) }, uChanged: { value: srgb(CHANGED) },
    uChangedAmount: { value: 0 }, uThickness: { value: 1.5 }, uEnabled: { value: 1 },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform sampler2D tMask; uniform vec2 uTexel;
    uniform vec3 uActive; uniform vec3 uSelected; uniform vec3 uChanged; uniform float uChangedAmount; uniform float uThickness; uniform float uEnabled;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uEnabled < 0.5) { gl_FragColor = base; return; }
      vec4 c = texture2D(tMask, vUv);
      float sel = 0.0, act = 0.0, chg = 0.0, hov = 0.0;
      for (int ring = 1; ring <= 2; ring++) {
        float rr = uThickness * float(ring) * 0.5 + 0.5;
        for (int i = 0; i < 12; i++) {
          float a = float(i) * 0.5235988 + float(ring) * 0.26;
          vec4 m = texture2D(tMask, vUv + vec2(cos(a), sin(a)) * uTexel * rr);
          float w = ring == 1 ? 0.34 : 0.2;
          sel += abs(m.r - c.r) > 0.1 && m.r > 0.2 && m.r < 0.7 ? w : 0.0;
          act += abs(m.r - c.r) > 0.1 && m.r > 0.7 ? w : 0.0;
          chg += abs(m.g - c.g) > 0.1 && m.g > 0.5 ? w : 0.0;
          hov += abs(m.b - c.b) > 0.1 && m.b > 0.5 ? w : 0.0;
        }
      }
      vec3 color = base.rgb; float alpha = base.a;
      float h = clamp(hov, 0.0, 1.0) * 0.45;
      color = mix(color, uSelected, h); alpha = mix(alpha, 1.0, h);
      float k = clamp(chg, 0.0, 1.0) * uChangedAmount;
      color = mix(color, uChanged, k); alpha = mix(alpha, 1.0, k);
      float s = clamp(sel, 0.0, 1.0);
      color = mix(color, uSelected, s); alpha = mix(alpha, 1.0, s);
      float t = clamp(act, 0.0, 1.0);
      color = mix(color, uActive, t); alpha = mix(alpha, 1.0, t);
      // inside a changed object, a faint wash of the accent while it fades
      if (c.g > 0.5) { color = mix(color, uChanged, 0.12 * uChangedAmount); }
      gl_FragColor = vec4(color, alpha);
    }`,
}

// ---------------------------------------------------------------------------------------------------
// Contact shadow: the model seen from below, blurred, laid under it as a soft dark pool.

class ContactShadow {
  constructor(renderer) {
    this.renderer = renderer
    this.group = new THREE.Group()
    this.group.name = '__contact'
    this.rt = new THREE.WebGLRenderTarget(512, 512)
    this.rt.texture.generateMipmaps = false
    this.blurRt = new THREE.WebGLRenderTarget(512, 512)
    this.blurRt.texture.generateMipmaps = false
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2)
    this.plane = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: this.rt.texture, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }))
    this.plane.scale.y = -1
    this.plane.renderOrder = -2
    this.group.add(this.plane)
    this.blurPlane = new THREE.Mesh(plane)
    this.blurPlane.visible = false
    this.group.add(this.blurPlane)
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.camera.rotation.x = Math.PI / 2
    this.group.add(this.camera)
    this.depth = new THREE.MeshDepthMaterial()
    this.depth.userData.darkness = { value: 1.6 }
    this.depth.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = this.depth.userData.darkness
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );', 'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );')}`
    }
    this.depth.depthTest = false
    this.depth.depthWrite = false
    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader); this.hBlur.depthTest = false
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader); this.vBlur.depthTest = false
  }

  fit(box) {
    const size = box.getSize(new THREE.Vector3())
    const span = Math.max(size.x, size.z) * 1.9 + Math.max(size.y, 1e-6) * 0.6
    this.group.position.set((box.min.x + box.max.x) / 2, box.min.y + span * 0.0005, (box.min.z + box.max.z) / 2)
    this.plane.scale.set(span, -1, span)
    this.blurPlane.scale.set(span, 1, span)
    this.camera.left = -span / 2; this.camera.right = span / 2; this.camera.top = span / 2; this.camera.bottom = -span / 2
    // only what is near the floor darkens it: a contact shadow, not a second sun
    this.camera.near = 0; this.camera.far = Math.max(Math.min(size.y * 0.3, Math.max(size.x, size.z) * 0.25), 1e-6)
    this.camera.updateProjectionMatrix()
    this.span = span
  }

  update(scene, hide) {
    const r = this.renderer
    const background = scene.background, environment = scene.environment
    const hidden = hide.filter((o) => o.visible)
    hidden.forEach((o) => { o.visible = false })
    this.plane.visible = false
    scene.background = null
    scene.overrideMaterial = this.depth
    const clear = r.getClearAlpha()
    r.setClearAlpha(0)
    const toneMapping = r.toneMapping
    r.toneMapping = THREE.NoToneMapping
    r.setRenderTarget(this.rt)
    r.clear()
    r.render(scene, this.camera)
    scene.overrideMaterial = null
    for (let i = 0; i < 2; i++) this.blur((0.9 + i * 0.6) / 256)
    r.setRenderTarget(null)
    r.toneMapping = toneMapping
    r.setClearAlpha(clear)
    scene.background = background
    scene.environment = environment
    hidden.forEach((o) => { o.visible = true })
    this.plane.visible = true
  }

  blur(amount) {
    const r = this.renderer
    this.blurPlane.visible = true
    this.blurPlane.material = this.hBlur
    this.hBlur.uniforms.tDiffuse.value = this.rt.texture
    this.hBlur.uniforms.h.value = amount
    r.setRenderTarget(this.blurRt)
    r.render(this.blurPlane, this.camera)
    this.blurPlane.material = this.vBlur
    this.vBlur.uniforms.tDiffuse.value = this.blurRt.texture
    this.vBlur.uniforms.v.value = amount
    r.setRenderTarget(this.rt)
    r.render(this.blurPlane, this.camera)
    this.blurPlane.visible = false
  }
}

// ---------------------------------------------------------------------------------------------------

export class Viewport {
  constructor(stage, canvas, hooks) {
    this.stage = stage
    this.canvas = canvas
    this.hooks = hooks
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: false })
    const r = this.renderer
    r.setClearColor(0x000000, 0)
    r.outputColorSpace = THREE.SRGBColorSpace
    r.toneMapping = THREE.AgXToneMapping
    r.shadowMap.enabled = true
    r.shadowMap.type = THREE.PCFShadowMap
    r.localClippingEnabled = true
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    r.setPixelRatio(this.pixelRatio)

    this.scene = new THREE.Scene()
    this.modelRoot = new THREE.Group(); this.modelRoot.name = '__model'
    this.helpers = new THREE.Group(); this.helpers.name = '__helpers'
    this.scene.add(this.modelRoot, this.helpers)
    this.envs = new Environments(r)
    this.matcap = clayMatcap()

    // Solid mode's studio lights ride with the camera, as Blender's do.
    this.headLights = new THREE.Group()
    const key = new THREE.DirectionalLight(0xfffaf2, 2.6); key.position.set(-0.6, 0.85, 0.9)
    const fill = new THREE.DirectionalLight(0xeef2ff, 0.55); fill.position.set(1, -0.15, 0.55)
    const rim = new THREE.DirectionalLight(0xffffff, 1.3); rim.position.set(0.3, 0.8, -1)
    for (const light of [key, fill, rim]) { this.headLights.add(light); this.headLights.add(light.target) }
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x6f6b64, 0.6)
    this.scene.add(this.headLights, this.hemi)

    // Rendered mode's sun, with a soft shadow; and a ground that only shows shadow.
    this.sun = new THREE.DirectionalLight(0xfff6ea, 2.2)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.radius = 6
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.02
    this.helpers.add(this.sun, this.sun.target)
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.13, depthWrite: false }))
    this.ground.receiveShadow = true
    this.ground.name = '__ground'
    this.helpers.add(this.ground)
    this.contact = new ContactShadow(r)
    this.helpers.add(this.contact.group)

    this.grid = new Grid()
    this.helpers.add(this.grid.mesh)
    this.sectionViz = this.makeSectionViz()
    this.helpers.add(this.sectionViz)
    this.overlay = new THREE.Group(); this.overlay.name = '__overlay'
    this.scene.add(this.overlay)

    this.nav = new Navigator(canvas, {
      changed: () => this.invalidate(),
      click: (e) => hooks.click(e),
      dblclick: (e) => hooks.dblclick(e),
      hover: (e) => hooks.hover?.(e),
      pick: (x, y) => this.pick(x, y)?.point ?? null,
      userInput: () => { if (this.cameraView) this.exitCameraView(); hooks.userInput?.() },
    })
    this.gizmo = new Gizmo(hooks.gizmoHost, this.nav, (view) => { if (this.cameraView) this.exitCameraView(); this.nav.view(view) })

    // Post
    const size = new THREE.Vector2(1, 1)
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
    this.composer = new EffectComposer(r, this.target)
    this.renderPass = new RenderPass(this.scene, this.nav.camera)
    this.renderPass.clearAlpha = 0
    this.gtao = new GTAOPass(this.scene, this.nav.persp, size.x, size.y)
    this.gtao.enabled = false
    this.gtao.blendIntensity = 0.85
    this.outline = new ShaderPass(OutlineShader)
    this.output = new OutputPass()
    // the outline goes on after tone mapping, so Blender's orange stays Blender's orange
    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.gtao)
    this.composer.addPass(this.output)
    this.composer.addPass(this.outline)
    this.mask = new THREE.WebGLRenderTarget(1, 1)
    this.maskMaterials = new Map()

    this.loader = new GLTFLoader()
    const draco = new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/')
    this.loader.setDRACOLoader(draco)
    this.loader.setKTX2Loader(new KTX2Loader().setTranscoderPath('/vendor/three/examples/jsm/libs/basis/').detectSupport(r))
    this.loader.setMeshoptDecoder(MeshoptDecoder)
    this.raycaster = new THREE.Raycaster()
    this.raycaster.layers.set(0)
    this.raycaster.params.Line = { threshold: 0 }

    // State
    this.options = {
      shading: 'solid', xray: false, solidLight: 'studio', solidColor: 'material', env: 'studio', background: 'light',
      sceneLights: false, grid: true, stats: true, outline: true, units: 'auto', ao: true, shadows: true,
    }
    this.items = []
    this.root = null
    this.renderables = []
    this.selection = new Set()
    this.active = null
    this.hovered = null
    this.changed = new Set()
    this.changedUntil = 0
    this.localView = null
    this.explode = 0
    this.section = { enabled: false, axis: 'z', offset: 0.5, flip: false, plane: new THREE.Plane(), range: [0, 1] }
    this.cameraView = null
    this.viewCamera = new THREE.PerspectiveCamera()
    this.anim = null
    this.mmPerUnit = 1
    this.unitSource = 'guess'
    this.bounds = new THREE.Box3()
    this.derived = new Map()
    this.needsRender = true
    this.needsContact = true
    this.last = performance.now()

    new ResizeObserver(() => this.resize()).observe(stage)
    this.resize()
    this.applyShading()
    requestAnimationFrame((t) => this.loop(t))
  }

  invalidate() { this.needsRender = true }

  resize() {
    const rect = this.stage.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height))
    if (w === this.width && h === this.height) return
    this.width = w; this.height = h
    this.renderer.setSize(w, h, false)
    this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`
    const pw = Math.round(w * this.pixelRatio), ph = Math.round(h * this.pixelRatio)
    this.composer.setPixelRatio(this.pixelRatio)
    this.composer.setSize(w, h)
    this.mask.setSize(pw, ph)
    this.outline.uniforms.uTexel.value.set(1 / pw, 1 / ph)
    this.outline.uniforms.uThickness.value = 1.6 * this.pixelRatio
    this.nav.setSize(w, h)
    this.invalidate()
  }

  // ---- loading ------------------------------------------------------------------------------------

  async parse(buffer, resourcePath) {
    return this.loader.parseAsync(buffer, resourcePath)
  }

  /**
   * Swap the model in. `keep` restores selection, visibility and explode by object path, and keeps
   * the camera unless the model moved out of view or changed size by a lot.
   */
  setModel(gltf, { report = null, keep = null } = {}) {
    const previous = keep ? this.captureState() : null
    const prevBounds = this.bounds.clone()
    const prevStats = keep ? this.itemStats() : null
    this.clearModel()
    const scene = gltf.scene
    this.gltf = gltf
    this.sceneExtras = scene.userData?.harness ?? gltf.parser?.json?.scenes?.[0]?.extras?.harness ?? null
    this.modelRoot.add(scene)
    scene.updateMatrixWorld(true)
    this.buildItems(gltf)
    this.renderables = this.items.flatMap((i) => i.meshes)
    for (const mesh of this.renderables) {
      mesh.userData.__orig = mesh.material
      mesh.frustumCulled = true
    }
    // lights from the file stay dark until asked for; cameras never draw
    this.sceneLights = []
    scene.traverse((o) => { if (o.isLight) { this.sceneLights.push({ light: o, intensity: o.intensity }); o.visible = false } })
    this.measureBase()
    this.detectUnits(report)
    this.buildAnimation(gltf)
    this.derived.clear()
    this.applyShading()

    const firstLoad = !keep
    if (previous) this.restoreState(previous)
    if (firstLoad) {
      const cam = this.sceneCameraItems()[0]
      if (cam) {
        const pose = this.cameraPose(cam.object)
        this.nav.yaw = pose.yaw; this.nav.pitch = Math.max(pose.pitch, -Math.PI / 2 + 0.05)
        this.nav.apply()
      }
      this.frameAll(false)
      this.placeSun()
    } else {
      const sphere = this.bounds.getBoundingSphere(new THREE.Sphere())
      const prevSphere = prevBounds.isEmpty() ? null : prevBounds.getBoundingSphere(new THREE.Sphere())
      const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.nav.camera.projectionMatrix, this.nav.camera.matrixWorldInverse))
      const grew = prevSphere ? sphere.radius / Math.max(prevSphere.radius, 1e-9) : Infinity
      if (!frustum.intersectsSphere(sphere) || grew > 3 || grew < 0.25) this.frameAll(true)
    }
    const diff = prevStats ? this.diffStats(prevStats, this.itemStats()) : null
    if (diff && (diff.changed.length || diff.added.length)) {
      this.changed = new Set(this.items.filter((i) => diff.changed.includes(i.path) || diff.added.includes(i.path)))
      this.changedUntil = performance.now() + 1800
    }
    this.needsContact = true
    this.updateSection()
    this.invalidate()
    return diff
  }

  clearModel() {
    if (!this.gltf) return
    this.modelRoot.remove(this.gltf.scene)
    this.gltf.scene.traverse((o) => {
      if (o.isMesh || o.isLine || o.isPoints) {
        o.geometry?.dispose()
        for (const m of [].concat(o.userData.__orig ?? o.material)) {
          if (!m) continue
          for (const value of Object.values(m)) if (value?.isTexture) value.dispose()
          m.dispose?.()
        }
      }
    })
    for (const m of this.derived.values()) m.dispose?.()
    this.derived.clear()
    this.mixer?.stopAllAction()
    this.mixer = null
    this.gltf = null
    this.items = []
    this.renderables = []
    this.selection.clear()
    this.active = null
    this.hovered = null
    this.changed.clear()
    this.localView = null
  }

  buildItems(gltf) {
    const parser = gltf.parser
    const json = parser?.json ?? {}
    const nodeOf = (o) => parser?.associations?.get(o)?.nodes
    let id = 0
    const make = (object, parent, depth) => {
      const nodeIndex = nodeOf(object)
      const def = nodeIndex !== undefined ? json.nodes?.[nodeIndex] : null
      const extras = { ...(object.userData ?? {}) }
      const facts = extras.harness ?? null
      delete extras.harness; delete extras.name
      const meshes = []
      if (object.isMesh || object.isLine || object.isPoints) meshes.push(object)
      // multi-primitive meshes arrive as a group whose children carry no node
      for (const child of object.children) if ((child.isMesh || child.isLine || child.isPoints) && nodeOf(child) === undefined) meshes.push(child)
      let type = facts?.type
      if (!type) {
        if (object.isCamera) type = 'CAMERA'
        else if (object.isLight) type = 'LIGHT'
        else if (meshes.length) type = 'MESH'
        else type = 'EMPTY'
      }
      const name = object.userData?.name ?? def?.name ?? object.name ?? `Node ${id}`
      const item = {
        id: id++, name, type, object, parent, depth, meshes, facts, extras, children: [], nodeIndex,
        path: parent ? `${parent.path}/${name}` : name, hidden: false,
        meshName: def?.mesh !== undefined ? json.meshes?.[def.mesh]?.name : null,
      }
      for (const m of meshes) m.userData.__item = item
      object.userData.__item = item
      for (const child of object.children) {
        if (nodeOf(child) !== undefined) item.children.push(make(child, item, depth + 1))
      }
      sortChildren(item)
      return item
    }
    const scene = gltf.scene
    const sceneName = json.scenes?.[json.scene ?? 0]?.name || 'Scene'
    const root = { id: id++, name: sceneName, type: 'SCENE', object: scene, parent: null, depth: -1, meshes: [], facts: null, extras: {}, children: [], path: '', hidden: false }
    for (const child of scene.children) if (nodeOf(child) !== undefined) root.children.push(make(child, root, 0))
    sortChildren(root)
    // Blender's own top row is "Scene Collection"; when the file has it, it is the root.
    if (root.children.length === 1 && root.children[0].type === 'COLLECTION' && root.children[0].name === 'Scene Collection') {
      const sc = root.children[0]
      sc.parent = null
      const reDepth = (item, depth) => { item.depth = depth; item.children.forEach((c) => reDepth(c, depth + 1)) }
      reDepth(sc, 0)
      this.root = sc
    } else {
      this.root = root
    }
    const all = []
    const walk = (item) => { if (item.type !== 'SCENE') all.push(item); item.children.forEach(walk) }
    walk(this.root)
    this.items = all
    for (const item of all) item.stats = this.statsOf(item)
  }

  statsOf(item) {
    let vertices = 0, triangles = 0
    for (const m of item.meshes) {
      const g = m.geometry
      if (!g?.attributes?.position) continue
      vertices += g.attributes.position.count
      if (m.isMesh) triangles += (g.index ? g.index.count : g.attributes.position.count) / 3
    }
    return { vertices, triangles: Math.round(triangles) }
  }

  itemStats() {
    const out = new Map()
    for (const item of this.items) {
      const box = this.boxOf([item], false)
      const look = item.meshes.flatMap((m) => [].concat(m.userData.__orig ?? m.material)).map((m) => `${m?.name}:${m?.color?.getHexString() ?? ''}:${m?.roughness ?? ''}:${m?.metalness ?? ''}:${m?.map?.uuid ? 'map' : ''}`).join('|')
      out.set(item.path, { t: item.stats.triangles, v: item.stats.vertices, box: box.isEmpty() ? '' : [...box.min.toArray(), ...box.max.toArray()].map((n) => n.toFixed(4)).join(','), type: item.type, look })
    }
    return out
  }

  diffStats(before, after) {
    const added = [], removed = [], changed = []
    for (const [path, s] of after) {
      const b = before.get(path)
      if (!b) { added.push(path); continue }
      if (b.t !== s.t || b.v !== s.v || b.box !== s.box || b.look !== s.look) changed.push(path)
    }
    for (const path of before.keys()) if (!after.has(path)) removed.push(path)
    const name = (p) => p.split('/').pop()
    const meshy = (p, map) => map.get(p)?.type === 'MESH'
    return {
      added: added.filter((p) => meshy(p, after)), removed: removed.filter((p) => meshy(p, before)), changed: changed.filter((p) => meshy(p, after)),
      summary(limit = 3) {
        const parts = []
        const list = (arr, word) => { if (!arr.length) return; parts.push(arr.length <= limit ? `${arr.map(name).join(', ')} ${word}` : `${arr.length} objects ${word}`) }
        list(this.changed, 'changed'); list(this.added, 'added'); list(this.removed, 'removed')
        return parts.join(' · ')
      },
    }
  }

  measureBase() {
    // explode needs each part's own centre at rest
    this.modelRoot.updateMatrixWorld(true)
    for (const item of this.items) {
      item.explodeApplied = new THREE.Vector3()
      if (item.meshes.length) item.restCenter = this.boxOf([item], false, true).getCenter(new THREE.Vector3())
    }
    this.bounds = this.boxOf(this.items, true)
  }

  /** World box of items' own meshes (optionally only what is visible, optionally at rest). */
  boxOf(items, visibleOnly = true) {
    const box = new THREE.Box3()
    const tmp = new THREE.Box3()
    for (const item of items) {
      for (const m of item.meshes) {
        if (visibleOnly && !this.isShown(m)) continue
        const g = m.geometry
        if (!g) continue
        if (!g.boundingBox) g.computeBoundingBox()
        m.updateWorldMatrix(true, false)
        tmp.copy(g.boundingBox).applyMatrix4(m.matrixWorld)
        box.union(tmp)
      }
    }
    return box
  }

  isShown(mesh) { return mesh.layers.isEnabled(0) && mesh.visible }

  detectUnits(report) {
    const forced = { mm: 1, cm: 10, m: 1000, in: 25.4 }[this.options.units]
    const size = this.bounds.isEmpty() ? null : this.bounds.getSize(new THREE.Vector3())
    const blenderSize = size ? [size.x, size.z, size.y] : null
    if (forced) { this.mmPerUnit = forced; this.unitSource = 'chosen'; return }
    const mpu = this.sceneExtras?.metres_per_unit
    if (typeof mpu === 'number' && mpu > 0) { this.mmPerUnit = mpu * 1000; this.unitSource = 'file'; return }
    if (report?.size_mm && blenderSize) {
      const ratios = report.size_mm.map((v, i) => (blenderSize[i] > 1e-9 ? v / blenderSize[i] : null)).filter((v) => v && Number.isFinite(v))
      if (ratios.length) {
        const ratio = ratios.reduce((a, b) => a + b, 0) / ratios.length
        const decade = Math.pow(10, Math.round(Math.log10(ratio)))
        this.mmPerUnit = Math.abs(ratio / decade - 1) < 0.05 ? decade : ratio
        this.unitSource = 'report'
        return
      }
    }
    // glTF says metres; a Blender scene in millimetres exports "metres" that are really millimetres
    const largest = blenderSize ? Math.max(...blenderSize) : 1
    this.mmPerUnit = largest > 20 ? 1 : 1000
    this.unitSource = 'guess'
  }

  setUnits(units, report) {
    this.options.units = units
    this.detectUnits(report)
    this.invalidate()
  }

  // ---- animation ----------------------------------------------------------------------------------

  buildAnimation(gltf) {
    this.anim = null
    const clips = gltf.animations ?? []
    if (!clips.length) return
    this.mixer = new THREE.AnimationMixer(gltf.scene)
    let start = Infinity, end = 0
    const affects = new Set()
    for (const clip of clips) {
      const action = this.mixer.clipAction(clip)
      action.play()
      for (const track of clip.tracks) {
        if (track.times.length) { start = Math.min(start, track.times[0]); end = Math.max(end, track.times[track.times.length - 1]) }
        affects.add(track.name.split('.')[0])
      }
    }
    if (!Number.isFinite(start)) start = 0
    const fps = this.sceneExtras?.fps || 24
    // an action that only turns an empty with nothing under it (an old turntable rig) moves nothing
    // you can see: keep it out of the timeline
    const moves = (o) => { let seen = false; o.traverse((c) => { if (c.isMesh || c.isCamera || c.isLight) seen = true }); return seen }
    const visible = [...affects].some((name) => { const o = gltf.scene.getObjectByName(name); return o ? moves(o) : true })
    this.anim = { clips, start, end: Math.max(end, start + 1 / fps), time: start, playing: false, speed: 1, fps, loop: true, affects: [...affects], visible }
    this.mixer.setTime(start)
  }

  setTime(t) {
    if (!this.anim) return
    this.anim.time = THREE.MathUtils.clamp(t, this.anim.start, this.anim.end)
    this.removeExplode()
    this.mixer.setTime(this.anim.time)
    this.applyExplode()
    this.needsContact = true
    this.invalidate()
    this.hooks.animationChanged?.()
  }

  // ---- picking ------------------------------------------------------------------------------------

  ndc(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect()
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
  }

  get camera() { return this.cameraView ? this.viewCamera : this.nav.camera }

  pick(clientX, clientY) {
    if (!this.renderables.length) return null
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera)
    const targets = this.renderables.filter((m) => m.isMesh && this.isShown(m) && this.visibleInTree(m))
    const hits = this.raycaster.intersectObjects(targets, false)
    for (const hit of hits) {
      if (this.section.enabled && this.section.plane.distanceToPoint(hit.point) < 0) continue
      return { ...hit, item: hit.object.userData.__item }
    }
    return null
  }

  visibleInTree(o) {
    for (let p = o; p; p = p.parent) if (!p.visible) return false
    return true
  }

  // ---- shading ------------------------------------------------------------------------------------

  setOption(key, value) {
    this.options[key] = value
    if (['shading', 'xray', 'solidLight', 'solidColor', 'env', 'background', 'sceneLights', 'ao', 'shadows'].includes(key)) this.applyShading()
    if (key === 'grid') this.grid.mesh.visible = value
    this.invalidate()
  }

  objectColor(item) {
    let h = 2166136261
    for (const ch of item?.name ?? '') { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
    const hue = ((h >>> 0) % 360) / 360
    return new THREE.Color().setHSL(hue, 0.42, 0.62)
  }

  viewportColor(orig) {
    const facts = this.sceneExtras?.materials?.[orig?.name]
    if (facts?.viewport_color) return new THREE.Color().setRGB(facts.viewport_color[0], facts.viewport_color[1], facts.viewport_color[2], THREE.LinearSRGBColorSpace)
    return orig?.color ? orig.color.clone() : new THREE.Color(0.8, 0.8, 0.8)
  }

  derive(mesh, orig) {
    const o = this.options
    const item = mesh.userData.__item
    const key = [o.shading, o.xray, o.solidLight, o.solidColor, o.solidColor === 'object' ? item?.path : '', orig?.uuid, mesh.isLine ? 'line' : mesh.isPoints ? 'pts' : 'mesh', this.section.enabled].join('|')
    let m = this.derived.get(key)
    if (m) return m
    const xray = o.xray || o.shading === 'wire'
    if (mesh.isLine || mesh.isPoints) {
      m = orig.clone()
    } else if (o.shading === 'solid') {
      const color = o.solidColor === 'object' ? this.objectColor(item) : o.solidColor === 'single' ? new THREE.Color(0.72, 0.72, 0.7) : this.viewportColor(orig)
      if (o.solidLight === 'matcap') m = new THREE.MeshMatcapMaterial({ matcap: this.matcap, color })
      else if (o.solidLight === 'flat') m = new THREE.MeshBasicMaterial({ color })
      else m = new THREE.MeshStandardMaterial({ color, roughness: 0.48, metalness: 0, envMapIntensity: 1 })
      if (orig?.map && o.solidColor === 'texture') m.map = orig.map
      m.side = orig?.side ?? THREE.FrontSide
      if (orig?.alphaTest) m.alphaTest = orig.alphaTest
    } else if (o.shading === 'wire') {
      m = new THREE.MeshBasicMaterial({ color: 0xffffff, colorWrite: false, depthWrite: !o.xray })
    } else {
      m = orig.clone()
    }
    if (xray && o.shading !== 'wire' && !mesh.isLine) {
      m.transparent = true
      m.opacity = Math.min(m.opacity ?? 1, 0.38)
      m.depthWrite = false
    }
    if (this.section.enabled) {
      m.clippingPlanes = [this.section.plane]
      m.clipShadows = true
      if (!mesh.isLine) m.side = THREE.DoubleSide
    }
    hookCap(m)
    this.derived.set(key, m)
    return m
  }

  applyShading() {
    const o = this.options
    const r = this.renderer
    const mode = o.shading
    const bg = o.background
    for (const m of this.derived.values()) m.dispose?.()
    this.derived.clear()
    for (const mesh of this.renderables) {
      const orig = mesh.userData.__orig
      mesh.material = Array.isArray(orig) ? orig.map((mat) => this.derive(mesh, mat)) : this.derive(mesh, orig)
      const shadows = mode === 'rendered' && o.shadows && mesh.isMesh
      mesh.castShadow = shadows
      mesh.receiveShadow = shadows
    }
    this.updateWires()
    // lights and environment
    const solid = mode === 'solid' || mode === 'wire'
    this.headLights.visible = mode === 'solid' && o.solidLight === 'studio'
    this.hemi.visible = mode === 'solid' && o.solidLight === 'studio'
    this.scene.environment = mode === 'solid' ? (o.solidLight === 'studio' ? this.envs.get('soft') : null) : mode === 'wire' ? null : this.envs.get(o.env)
    this.scene.environmentIntensity = mode === 'solid' ? 0.28 : mode === 'rendered' ? 0.9 : 1
    this.sun.visible = mode === 'rendered'
    this.ground.visible = mode === 'rendered' && o.shadows
    this.contact.group.visible = mode === 'rendered' && o.shadows
    this.gtao.enabled = mode === 'rendered' && o.ao
    const useLights = o.sceneLights && (mode === 'material' || mode === 'rendered')
    for (const { light, intensity } of this.sceneLights ?? []) {
      light.visible = useLights
      if (light.isDirectionalLight) light.intensity = THREE.MathUtils.clamp(intensity / 683, 0.1, 8)
      else light.intensity = intensity * Math.pow(this.mmPerUnit, 2) / 683 / 4
      if (!light.isDirectionalLight) light.decay = 2
    }
    r.toneMapping = solid ? THREE.NeutralToneMapping : THREE.AgXToneMapping
    r.toneMappingExposure = mode === 'rendered' ? 1.05 : 1
    // background
    const world = bg === 'world' && (mode === 'material' || mode === 'rendered')
    this.scene.background = world ? this.envs.get(o.env) : null
    this.scene.backgroundBlurriness = world ? 0.22 : 0
    this.scene.backgroundIntensity = 1
    const dark = world ? true : ['dark', 'black'].includes(bg)
    this.grid.setTheme(dark)
    this.darkBackground = dark
    this.hooks.backgroundChanged?.(world ? 'world' : bg, dark)
    this.needsContact = true
    this.invalidate()
  }

  /** Wireframe: edges as lines on each mesh, built lazily and kept. */
  updateWires() {
    const on = this.options.shading === 'wire'
    for (const mesh of this.renderables) {
      if (!mesh.isMesh) continue
      let wire = mesh.userData.__wire
      if (on && !wire) {
        const geometry = new THREE.EdgesGeometry(mesh.geometry, 1)
        wire = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x2b2b2b, transparent: true, opacity: 0.85 }))
        wire.name = '__wire'
        wire.raycast = () => {}
        mesh.add(wire)
        mesh.userData.__wire = wire
      }
      if (wire) {
        wire.visible = on
        wire.layers.mask = mesh.layers.mask
        const mat = wire.material
        mat.clippingPlanes = this.section.enabled ? [this.section.plane] : null
        mat.needsUpdate = true
      }
    }
    this.colorWires()
  }

  colorWires() {
    if (this.options.shading !== 'wire') return
    const selected = this.selectedMeshes()
    for (const mesh of this.renderables) {
      const wire = mesh.userData.__wire
      if (!wire) continue
      const item = mesh.userData.__item
      const color = item === this.active || selected.has(mesh) ? (this.darkBackground ? ACTIVE : SELECTED) : this.darkBackground ? new THREE.Color(0xd8d8d8) : new THREE.Color(0x303030)
      wire.material.color.copy(color)
      wire.material.opacity = selected.has(mesh) ? 1 : this.darkBackground ? 0.7 : 0.75
    }
  }

  // ---- selection & visibility ---------------------------------------------------------------------

  descendants(item, out = []) {
    out.push(item)
    for (const c of item.children) this.descendants(c, out)
    return out
  }

  selectedMeshes() {
    const set = new Set()
    for (const item of this.selection) for (const d of this.descendants(item)) for (const m of d.meshes) set.add(m)
    return set
  }

  select(item, { extend = false, toggle = false } = {}) {
    if (!item) { if (!extend) { this.selection.clear(); this.active = null } }
    else if (toggle && this.selection.has(item)) { this.selection.delete(item); if (this.active === item) this.active = [...this.selection].pop() ?? null }
    else { if (!extend) this.selection.clear(); this.selection.add(item); this.active = item }
    this.colorWires()
    this.invalidate()
    this.hooks.selectionChanged?.()
  }

  selectAll() {
    this.selection = new Set(this.items.filter((i) => i.meshes.length))
    this.active = this.active && this.selection.has(this.active) ? this.active : [...this.selection][0] ?? null
    this.colorWires(); this.invalidate(); this.hooks.selectionChanged?.()
  }

  setHover(item) {
    if (item === this.hovered) return
    this.hovered = item
    this.invalidate()
  }

  /** Effective visibility: an object's own eye, every hidden ancestor collection, local view. */
  refreshVisibility() {
    const local = this.localView ? new Set(this.localView.items.flatMap((i) => this.descendants(i))) : null
    for (const item of this.items) {
      let shown = !item.hidden
      for (let p = item.parent; p && shown; p = p.parent) if (p.hidden && (p.type === 'COLLECTION' || p.type === 'SCENE')) shown = false
      if (local && !local.has(item)) shown = false
      item.shown = shown
      for (const m of item.meshes) {
        m.layers.set(shown ? 0 : 1)
        if (m.userData.__wire) m.userData.__wire.layers.set(shown ? 0 : 1)
      }
    }
    this.needsContact = true
    this.invalidate()
    this.hooks.visibilityChanged?.()
  }

  setHidden(item, hidden) { item.hidden = hidden; this.refreshVisibility() }

  hideSelected() { for (const i of this.selection) i.hidden = true; this.select(null); this.refreshVisibility() }
  hideUnselected() {
    const keep = new Set([...this.selection].flatMap((i) => [...this.descendants(i), ...this.ancestors(i)]))
    for (const i of this.items) if (!keep.has(i) && i.meshes.length) i.hidden = true
    this.refreshVisibility()
  }
  unhideAll() { for (const i of this.items) i.hidden = false; this.refreshVisibility() }
  ancestors(item) { const out = []; for (let p = item.parent; p; p = p.parent) out.push(p); return out }

  toggleLocalView() {
    if (this.localView) {
      const back = this.localView.camera
      this.localView = null
      this.refreshVisibility()
      this.nav.restore(back, true)
      return false
    }
    if (!this.selection.size) return false
    this.localView = { items: [...this.selection], camera: this.nav.snapshot() }
    this.refreshVisibility()
    this.frameSelected()
    return true
  }

  // ---- framing ------------------------------------------------------------------------------------

  frameBox(box, animate = true) {
    if (box.isEmpty()) return
    this.nav.fitBox(box, { animate })
  }

  /** Frame everything shown; `atExplode` frames the model as it will be at that explode amount. */
  frameAll(animate = true, atExplode = null) {
    let box
    if (atExplode !== null && atExplode !== this.explode) {
      const was = this.explode
      this.removeExplode(); this.explode = atExplode; this.applyExplode()
      box = this.boxOf(this.items, true)
      this.removeExplode(); this.explode = was; this.applyExplode()
    } else box = this.boxOf(this.items, true)
    const all = box.isEmpty() ? this.boxOf(this.items, false) : box
    if (all.isEmpty()) return
    const sphere = all.getBoundingSphere(new THREE.Sphere())
    this.nav.setSceneRadius(Math.max(sphere.radius, this.bounds.isEmpty() ? 0 : this.bounds.getBoundingSphere(new THREE.Sphere()).radius))
    this.frameBox(all, animate)
  }

  frameSelected() {
    const items = [...this.selection].flatMap((i) => this.descendants(i))
    const box = this.boxOf(items, true)
    if (box.isEmpty()) return this.frameAll()
    this.frameBox(box)
  }

  // ---- scene cameras ------------------------------------------------------------------------------

  sceneCameraItems() {
    const preferred = this.sceneExtras?.camera
    const cams = this.items.filter((i) => i.object.isCamera)
    return cams.sort((a, b) => (b.name === preferred) - (a.name === preferred))
  }

  cameraPose(camera) {
    camera.updateWorldMatrix(true, false)
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion()
    camera.matrixWorld.decompose(position, quaternion, new THREE.Vector3())
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion)
    return { position, quaternion, yaw: Math.atan2(-forward.x, -forward.z), pitch: Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)) }
  }

  enterCameraView(item) {
    item = item ?? this.sceneCameraItems()[0]
    if (!item) return false
    const pose = this.cameraPose(item.object)
    const center = this.bounds.isEmpty() ? pose.position.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion)) : this.bounds.getCenter(new THREE.Vector3())
    const depth = Math.max(center.clone().sub(pose.position).dot(new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion)), 1e-3)
    this.cameraView = { item, previous: this.nav.snapshot(), depth }
    this.hooks.cameraViewChanged?.(item)
    this.invalidate()
    return true
  }

  exitCameraView() {
    if (!this.cameraView) return
    const pose = this.cameraPose(this.cameraView.item.object)
    this.nav.fromCamera(pose.position, pose.quaternion, this.cameraView.depth)
    this.cameraView = null
    this.hooks.cameraViewChanged?.(null)
    this.invalidate()
  }

  /** The render camera while looking through a scene camera: its pose, a field of view wide enough
   *  that its frame sits inside the viewport with a margin, and the frame's rectangle for the mask. */
  updateViewCamera() {
    const src = this.cameraView.item.object
    src.updateWorldMatrix(true, false)
    const cam = this.viewCamera
    src.matrixWorld.decompose(cam.position, cam.quaternion, new THREE.Vector3())
    const aspect = src.isPerspectiveCamera ? (this.cameraView.item.object.aspect || 16 / 9) : 16 / 9
    const vfov = (src.fov ?? 40) * Math.PI / 180
    const viewAspect = this.width / this.height
    const margin = 0.88
    let frameH
    if (viewAspect > aspect) frameH = this.height * margin
    else frameH = (this.width * margin) / aspect
    const frameW = frameH * aspect
    cam.fov = (2 * Math.atan(Math.tan(vfov / 2) * (this.height / frameH)) * 180) / Math.PI
    cam.aspect = viewAspect
    cam.near = src.near ?? 0.01
    cam.far = Math.max(src.far ?? 1000, this.bounds.isEmpty() ? 1000 : this.bounds.getSize(new THREE.Vector3()).length() * 50)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    this.cameraFrame = { x: (this.width - frameW) / 2, y: (this.height - frameH) / 2, w: frameW, h: frameH }
  }

  // ---- explode ------------------------------------------------------------------------------------

  setExplode(amount) {
    this.removeExplode()
    this.explode = amount
    this.applyExplode()
    this.needsContact = true
    this.invalidate()
  }

  removeExplode() {
    for (const item of this.items) {
      if (item.explodeApplied && item.explodeApplied.lengthSq() > 0) {
        item.object.position.sub(item.explodeApplied)
        item.explodeApplied.set(0, 0, 0)
      }
    }
    this.modelRoot.updateMatrixWorld(true)
  }

  applyExplode() {
    if (!this.explode || !this.items.length) return
    const parts = this.items.filter((i) => i.meshes.length && i.restCenter)
    if (parts.length < 2) return
    const rest = new THREE.Box3()
    for (const p of parts) rest.expandByPoint(p.restCenter)
    const center = this.bounds.getCenter(new THREE.Vector3())
    const radius = this.bounds.getSize(new THREE.Vector3()).length() / 2
    const k = this.explode * 0.9
    const worldOffset = new Map()
    const order = []
    const walk = (item) => { order.push(item); item.children.forEach(walk) }
    walk(this.root)
    for (const item of order) {
      if (!parts.includes(item)) continue
      const dir = item.restCenter.clone().sub(center)
      if (dir.length() < radius * 0.02) dir.set(0, radius * 0.35, 0)
      const desired = dir.multiplyScalar(k)
      let inherited = new THREE.Vector3()
      for (let p = item.parent; p; p = p.parent) if (worldOffset.has(p)) { inherited = worldOffset.get(p); break }
      worldOffset.set(item, desired)
      const delta = desired.clone().sub(inherited)
      const parent = item.object.parent
      parent.updateWorldMatrix(true, false)
      const inv = new THREE.Matrix4().extractRotation(parent.matrixWorld)
      const scale = new THREE.Vector3().setFromMatrixScale(parent.matrixWorld)
      inv.invert()
      delta.applyMatrix4(inv).divide(scale)
      item.object.position.add(delta)
      item.explodeApplied.copy(delta)
      item.object.updateMatrixWorld(true)
    }
  }

  // ---- section ------------------------------------------------------------------------------------

  makeSectionViz() {
    const group = new THREE.Group()
    group.name = '__section'
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: CHANGED, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }))
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: CHANGED, transparent: true, opacity: 0.8, toneMapped: false }))
    fill.raycast = () => {}; edge.raycast = () => {}
    group.add(fill, edge)
    group.visible = false
    return group
  }

  setSection(patch) {
    const wasOn = this.section.enabled
    Object.assign(this.section, patch)
    if (wasOn !== this.section.enabled) {
      capUniforms.uCapOn.value = this.section.enabled ? 1 : 0
      this.applyShading()
    }
    this.updateSection()
    this.invalidate()
  }

  /** The cut, in Blender's axes: keep what is below `offset` along the axis (or above, flipped). */
  updateSection() {
    const s = this.section
    const box = this.boxOf(this.items, false)
    const axis = AXIS_DIR[s.axis]
    if (box.isEmpty()) { this.sectionViz.visible = false; return }
    const corners = []
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z))
    const along = corners.map((c) => c.dot(axis))
    const lo = Math.min(...along), hi = Math.max(...along)
    s.range = [lo, hi]
    const at = lo + (hi - lo) * s.offset
    s.at = at
    if (s.flip) s.plane.set(axis.clone(), -at)
    else s.plane.set(axis.clone().negate(), at)
    // the frame of the cut
    const size = box.getSize(new THREE.Vector3()).multiplyScalar(1.12)
    const center = box.getCenter(new THREE.Vector3())
    const viz = this.sectionViz
    viz.visible = s.enabled && s.showPlane !== false
    viz.position.copy(center).addScaledVector(axis, at - center.dot(axis))
    viz.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis)
    const [w, h] = s.axis === 'x' ? [size.z, size.y] : s.axis === 'y' ? [size.x, size.y] : [size.x, size.z]
    viz.scale.set(w, h, 1)
    this.needsContact = true
  }

  // ---- render loop --------------------------------------------------------------------------------

  loop(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    if (this.nav.update(now, dt)) this.needsRender = true
    if (this.anim?.playing) {
      let t = this.anim.time + dt * this.anim.speed
      if (t > this.anim.end) t = this.anim.loop ? this.anim.start + ((t - this.anim.start) % (this.anim.end - this.anim.start || 1)) : this.anim.end
      if (!this.anim.loop && t >= this.anim.end) this.anim.playing = false
      this.setTime(t)
    }
    if (this.changedUntil) {
      const left = (this.changedUntil - now) / 1800
      this.outline.uniforms.uChangedAmount.value = Math.max(0, Math.min(1, left * 1.6))
      if (left <= 0) { this.changedUntil = 0; this.changed.clear() }
      this.needsRender = true
    }
    if (this.needsRender) {
      this.needsRender = false
      this.render()
    }
    requestAnimationFrame((t) => this.loop(t))
  }

  render() {
    const cam = this.cameraView ? (this.updateViewCamera(), this.viewCamera) : this.nav.camera
    const r = this.renderer
    // head lights follow the camera
    this.headLights.position.copy(cam.position)
    this.headLights.quaternion.copy(cam.quaternion)
    this.headLights.updateMatrixWorld(true)
    // grid under the view
    const sphere = this.bounds.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : this.bounds.getBoundingSphere(new THREE.Sphere())
    this.grid.mesh.visible = this.options.grid && this.options.shading !== 'rendered'
    this.grid.update(this.nav.target, this.nav.worldPerPixel(), Math.max(this.nav.distance * 2.4, sphere.radius * 3), this.mmPerUnit)
    // rendered: the sun and the ground sized to the model
    if (this.options.shading === 'rendered' && !this.bounds.isEmpty()) {
      const box = this.boxOf(this.items, true)
      const b = box.isEmpty() ? this.bounds : box
      const c = b.getCenter(new THREE.Vector3())
      const rad = b.getBoundingSphere(new THREE.Sphere()).radius
      const dir = this.sunDir ?? new THREE.Vector3(-0.35, 0.85, 0.4).normalize()
      this.sun.position.copy(c).addScaledVector(dir, rad * 4.5)
      this.sun.target.position.copy(c)
      const sc = this.sun.shadow.camera
      sc.left = -rad * 1.6; sc.right = rad * 1.6; sc.top = rad * 1.6; sc.bottom = -rad * 1.6
      sc.near = rad * 0.1; sc.far = rad * 10
      sc.updateProjectionMatrix()
      this.ground.position.set(c.x, b.min.y - rad * 0.0005, c.z)
      this.ground.scale.set(rad * 12, 1, rad * 12)
      if (this.needsContact && this.options.shadows) {
        this.contact.fit(b)
        this.contact.update(this.scene, [this.helpers, this.overlay, this.headLights, this.grid.mesh])
        this.needsContact = false
      }
      this.gtao.updateGtaoMaterial({ radius: rad * 0.12, distanceExponent: 1.4, thickness: rad * 0.05, scale: 1, samples: 12 })
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 })
    }
    // passes see the same camera
    this.renderPass.camera = cam
    if (this.gtao.enabled && this.gtao.camera !== cam) {
      this.gtao.camera = cam
      const persp = cam.isPerspectiveCamera ? 1 : 0
      for (const m of [this.gtao.gtaoMaterial, this.gtao.depthRenderMaterial]) { m.defines.PERSPECTIVE_CAMERA = persp; m.needsUpdate = true }
    }
    // selection mask
    const selected = this.selectedMeshes()
    const wantOutline = this.options.outline && this.options.shading !== 'wire' && (selected.size || this.hovered || this.changed.size)
    this.outline.uniforms.uEnabled.value = wantOutline ? 1 : 0
    if (wantOutline) this.renderMask(cam, selected)
    this.composer.render()
    this.hooks.afterRender?.(cam)
  }

  renderMask(cam, selected) {
    const r = this.renderer
    const active = new Set(this.active ? this.descendants(this.active).flatMap((i) => i.meshes) : [])
    const hovered = new Set(this.hovered ? this.descendants(this.hovered).flatMap((i) => i.meshes) : [])
    const changed = new Set([...this.changed].flatMap((i) => i.meshes))
    const swaps = []
    const materialFor = (red, green, blue, side) => {
      const key = `${red}${green}${blue}${side}${this.section.enabled}`
      let m = this.maskMaterials.get(key)
      if (!m) {
        m = new THREE.MeshBasicMaterial({ color: new THREE.Color(red, green, blue), side, toneMapped: false })
        this.maskMaterials.set(key, m)
      }
      m.clippingPlanes = this.section.enabled ? [this.section.plane] : null
      return m
    }
    for (const mesh of this.renderables) {
      if (!mesh.isMesh) continue
      const red = active.has(mesh) ? 1 : selected.has(mesh) ? 0.5 : 0
      const green = changed.has(mesh) ? 1 : 0
      const blue = hovered.has(mesh) && !selected.has(mesh) ? 1 : 0
      const side = this.section.enabled ? THREE.DoubleSide : (Array.isArray(mesh.userData.__orig) ? mesh.userData.__orig[0] : mesh.userData.__orig)?.side ?? THREE.FrontSide
      swaps.push([mesh, mesh.material])
      mesh.material = materialFor(red, green, blue, side)
    }
    const helpers = this.helpers.visible, overlay = this.overlay.visible, bg = this.scene.background
    this.helpers.visible = false; this.overlay.visible = false; this.scene.background = null
    const toneMapping = r.toneMapping
    r.toneMapping = THREE.NoToneMapping
    r.setRenderTarget(this.mask)
    r.setClearColor(0x000000, 0)
    r.clear()
    r.render(this.scene, cam)
    r.setRenderTarget(null)
    r.toneMapping = toneMapping
    this.helpers.visible = helpers; this.overlay.visible = overlay; this.scene.background = bg
    for (const [mesh, material] of swaps) mesh.material = material
    this.outline.uniforms.tMask.value = this.mask.texture
  }

  /** A PNG of the view at `scale`× the pane, on the pane's background. */
  async capture(scale = 2, paintBackground) {
    const r = this.renderer
    const ratio = this.pixelRatio
    this.pixelRatio = scale
    r.setPixelRatio(scale)
    this.width = 0
    this.resize()
    this.needsContact = true
    this.render()
    const w = this.canvas.width, h = this.canvas.height
    const out = document.createElement('canvas')
    out.width = w; out.height = h
    const g = out.getContext('2d')
    paintBackground?.(g, w, h)
    g.drawImage(this.canvas, 0, 0)
    this.pixelRatio = ratio
    r.setPixelRatio(ratio)
    this.width = 0
    this.resize()
    this.render()
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'))
  }

  /** Rendered mode's sun, fixed in the world but chosen from the first view: high, over the viewer's
   *  left shoulder, so the shadow falls behind and to the right like a product shot. */
  placeSun() {
    const q = this.nav.quaternion
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q).setY(0)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q).setY(0)
    if (back.lengthSq() < 1e-6) back.set(0, 0, 1)
    back.normalize(); right.normalize()
    const horizontal = back.multiplyScalar(Math.cos(0.75)).addScaledVector(right, -Math.sin(0.75)).normalize()
    this.sunDir = horizontal.multiplyScalar(Math.cos(1.0)).add(new THREE.Vector3(0, Math.sin(1.0), 0)).normalize()
  }

  // ---- persistence --------------------------------------------------------------------------------

  captureState() {
    return {
      camera: this.nav.snapshot(),
      selection: [...this.selection].map((i) => i.path),
      active: this.active?.path ?? null,
      hidden: this.items.filter((i) => i.hidden).map((i) => i.path),
      local: this.localView ? { items: this.localView.items.map((i) => i.path), camera: this.localView.camera } : null,
      explode: this.explode,
      time: this.anim?.time ?? null,
    }
  }

  restoreState(s, { camera = true } = {}) {
    if (!s) return
    const byPath = new Map(this.items.map((i) => [i.path, i]))
    for (const p of s.hidden ?? []) { const i = byPath.get(p); if (i) i.hidden = true }
    this.selection = new Set((s.selection ?? []).map((p) => byPath.get(p)).filter(Boolean))
    this.active = byPath.get(s.active) ?? [...this.selection].pop() ?? null
    if (s.local) {
      const items = s.local.items.map((p) => byPath.get(p)).filter(Boolean)
      if (items.length) this.localView = { items, camera: s.local.camera }
    }
    this.refreshVisibility()
    if (s.explode) { this.explode = s.explode; this.applyExplode() }
    if (s.time !== null && s.time !== undefined && this.anim) this.setTime(s.time)
    if (camera && s.camera) this.nav.restore(s.camera)
    if (!this.bounds.isEmpty()) this.nav.setSceneRadius(this.bounds.getBoundingSphere(new THREE.Sphere()).radius)
    this.colorWires()
    this.hooks.selectionChanged?.()
  }
}
