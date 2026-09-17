// The stage: MuJoCo's compiled model drawn with three.js the way simulate draws it.
//
// Geometry and materials come out of the compiled model (mesh_vert/mesh_face, geom_size, mat_rgba,
// mat_texid → tex_data), lights and per-geom texture flags out of one mjv_updateScene pass at load,
// and decorations — contact points and forces, joint axes, actuators, centres of mass, inertia
// boxes, frames, sites, tendons, the perturbation spring — out of mjv_updateScene every frame they
// are on, so they are MuJoCo's own, sized and coloured by the model's <visual>.
//
// Colour is MuJoCo's too: no sRGB transform anywhere (ColorManagement off, linear output), Phong
// shading, light intensities scaled by π so three.js's Lambert term equals OpenGL's.
//
// MuJoCo is Z-up and so is this scene: the camera's up is (0, 0, 1) and no axis is swizzled.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Reflector } from 'three/addons/objects/Reflector.js'

THREE.ColorManagement.enabled = false

const PI = Math.PI
const HIGHLIGHT = new THREE.Color(0.22, 0.55, 0.85)

export class Stage {
  constructor(canvas) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(2, -2, 1.2)
    this.scene.add(this.camera)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.screenSpacePanning = true
    this.controls.zoomToCursor = true
    this.controls.rotateSpeed = 0.8

    this.root = null            // everything built from one model
    this.bodies = new Map()     // body id → Group
    this.meshes = []            // { mesh, geom, body, group, material, baseOpacity, plane }
    this.owned = []             // disposables for this model
    this.sky = null
    this.floor = null           // { top, mirror, reflectance }
    this.lights = []
    this.decor = new Decor(this.scene)
    this.settings = {}
    this.selected = -1
    this.cameraMode = { kind: 'free' }
    this.trackLast = null
    this.extent = 1
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas.parentElement)
    this.resize()
  }

  /** A panel covering `px` on the right: shift the picture so the scene centres in what is left. */
  setInset(px) {
    this.inset = px
    this.resize()
  }

  resize() {
    const host = this.canvas.parentElement
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    if (this.inset > 0) this.camera.setViewOffset(width, height, this.inset / 2, 0, width, height)
    else this.camera.clearViewOffset()
    this.camera.updateProjectionMatrix()
    if (this.floor?.mirror) {
      const size = new THREE.Vector2()
      this.renderer.getDrawingBufferSize(size)
      this.floor.mirror.getRenderTarget().setSize(Math.max(256, size.x >> 1), Math.max(256, size.y >> 1))
    }
  }

  // ─── Building a model ───────────────────────────────────────────────────────────────────────

  build(engine, { keepCamera = false } = {}) {
    const m = engine.mujoco, model = engine.model, data = engine.data
    const previousCamera = keepCamera ? this.saveCamera() : null
    this.dispose()
    this.root = new THREE.Group()
    this.scene.add(this.root)
    this.extent = Number(model.stat.extent) || 1

    // One full mjv_updateScene pass: per-geom texture flags (the bindings cannot read
    // mat_texuniform directly) and the lights, headlight included, as simulate sets them up.
    const option = engine.option
    const groups = Array.from(option.geomgroup)
    for (let i = 0; i < 6; i++) option.geomgroup[i] = 1
    m.mjv_updateScene(model, data, option, engine.perturb, engine.camera, m.mjtCatBit.mjCAT_ALL.value, engine.scene)
    for (let i = 0; i < 6; i++) option.geomgroup[i] = groups[i]
    const geomInfo = new Map()
    const scn = engine.scene
    const vec = scn.geoms
    for (let i = 0; i < scn.ngeom; i++) {
      const g = vec.get(i)
      if (g.objtype === m.mjtObj.mjOBJ_GEOM.value) geomInfo.set(g.objid, { texuniform: g.texuniform, reflectance: g.reflectance })
      g.delete()
    }
    vec.delete()
    const lights = []
    const lvec = scn.lights
    for (let i = 0; i < scn.nlight; i++) {
      const l = lvec.get(i)
      lights.push({ headlight: l.headlight, type: l.type, castshadow: l.castshadow, pos: Array.from(l.pos), dir: Array.from(l.dir),
        diffuse: Array.from(l.diffuse), ambient: Array.from(l.ambient), specular: Array.from(l.specular), cutoff: l.cutoff, exponent: l.exponent })
      l.delete()
    }
    lvec.delete()

    const T = m.mjtGeom
    const textures = new Map()
    const ntexrole = model.nmat ? model.mat_texid.length / model.nmat : 0
    const meshCache = new Map()
    const haze = model.vis.rgba.haze

    for (let g = 0; g < model.ngeom; g++) {
      const type = model.geom_type[g]
      const matid = model.geom_matid[g]
      const rgba = matid >= 0 ? model.mat_rgba.subarray(matid * 4, matid * 4 + 4) : model.geom_rgba.subarray(g * 4, g * 4 + 4)
      if (rgba[3] <= 0) continue
      const size = [model.geom_size[3 * g], model.geom_size[3 * g + 1], model.geom_size[3 * g + 2]]
      const body = model.geom_bodyid[g]
      const plane = type === T.mjGEOM_PLANE.value
      const texid = matid >= 0 && ntexrole ? (model.mat_texid[matid * ntexrole + 1] >= 0 ? model.mat_texid[matid * ntexrole + 1] : model.mat_texid[matid * ntexrole]) : -1
      const tex2d = texid >= 0 && model.tex_type[texid] === m.mjtTexture.mjTEXTURE_2D.value ? texid : -1
      const info = geomInfo.get(g) ?? { texuniform: 0, reflectance: 0 }

      let geometry = null
      let infinite = false
      if (type === T.mjGEOM_MESH.value) {
        const id = model.geom_dataid[g]
        if (id < 0) continue
        const wantUv = tex2d >= 0 && model.mesh_texcoordnum[id] > 0
        const key = `${id}:${wantUv}`
        if (!meshCache.has(key)) { const made = meshGeometry(model, id, wantUv); this.owned.push(made); meshCache.set(key, made) }
        geometry = meshCache.get(key)
      } else if (plane) {
        infinite = !(size[0] > 0 && size[1] > 0)
        const far = Math.max(60, this.extent * 60)
        const hx = size[0] > 0 ? size[0] : far, hy = size[1] > 0 ? size[1] : far
        geometry = new THREE.PlaneGeometry(2 * hx, 2 * hy)
        size[0] = hx; size[1] = hy
        this.owned.push(geometry)
      } else if (type === T.mjGEOM_HFIELD.value) {
        geometry = hfieldGeometry(model, model.geom_dataid[g])
        if (geometry) this.owned.push(geometry)
      } else {
        geometry = primitive(T, type, size)
        if (geometry) this.owned.push(geometry)
      }
      if (!geometry) continue

      const spec = matid >= 0 ? model.mat_specular[matid] : 0.5
      const shin = matid >= 0 ? model.mat_shininess[matid] : 0.5
      const emis = matid >= 0 ? model.mat_emission[matid] : 0
      const material = new THREE.MeshPhongMaterial({
        color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
        specular: new THREE.Color(spec, spec, spec).multiplyScalar(0.5),
        shininess: Math.max(1, shin * 128),
        emissive: new THREE.Color(rgba[0] * emis, rgba[1] * emis, rgba[2] * emis),
        transparent: rgba[3] < 1, opacity: rgba[3], side: plane ? THREE.FrontSide : THREE.FrontSide,
        fog: plane,
      })
      if (tex2d >= 0) {
        if (!textures.has(tex2d)) { const t = textureFromModel(model, tex2d); if (t) this.owned.push(t); textures.set(tex2d, t) }
        const base = textures.get(tex2d)
        if (base) {
          const map = base.clone()
          map.needsUpdate = true
          const rx = model.mat_texrepeat[2 * matid], ry = model.mat_texrepeat[2 * matid + 1]
          if (plane) {
            // Measured against MuJoCo's own renderer: a uniform plane repeats the texture every 2/texrepeat metres, centred on the origin.
            const repeatX = info.texuniform ? size[0] * rx : rx
            const repeatY = info.texuniform ? size[1] * ry : ry
            map.repeat.set(repeatX, repeatY)
            map.offset.set(frac(0.5 - repeatX / 2), frac(0.5 - repeatY / 2))
          } else {
            map.repeat.set(rx, ry)
          }
          map.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
          material.map = map
          this.owned.push(map)
        }
      }
      this.owned.push(material)

      const mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = !plane
      mesh.receiveShadow = true
      mesh.position.set(model.geom_pos[3 * g], model.geom_pos[3 * g + 1], model.geom_pos[3 * g + 2])
      mesh.quaternion.set(model.geom_quat[4 * g + 1], model.geom_quat[4 * g + 2], model.geom_quat[4 * g + 3], model.geom_quat[4 * g])
      if (!this.bodies.has(body)) { const group = new THREE.Group(); this.bodies.set(body, group); this.root.add(group) }
      this.bodies.get(body).add(mesh)
      const entry = { mesh, geom: g, body, group: Math.min(5, Math.max(0, model.geom_group[g])), material, baseOpacity: rgba[3], plane, emissive: material.emissive.clone() }
      this.meshes.push(entry)

      const reflectance = matid >= 0 ? model.mat_reflectance[matid] : 0
      if (plane && reflectance > 0 && !this.floor) {
        const mirror = new Reflector(new THREE.PlaneGeometry(2 * size[0], 2 * size[1]), { clipBias: 0.0005, textureWidth: 512, textureHeight: 512, color: 0xffffff, multisample: 0 })
        mirror.position.copy(mesh.position)
        mirror.quaternion.copy(mesh.quaternion)
        mirror.renderOrder = -1
        this.bodies.get(body).add(mirror)
        material.polygonOffset = true
        material.polygonOffsetFactor = -1
        material.polygonOffsetUnits = -4
        material.transparent = true
        material.depthWrite = true
        this.floor = { top: mesh, mirror, reflectance, entry, infinite }
        this.owned.push({ dispose: () => mirror.dispose() })
        const render = mirror.onBeforeRender
        mirror.onBeforeRender = (renderer, scene, camera) => {
          mesh.visible = false
          if (this.sky) this.sky.visible = false
          this.decor.group.visible = false
          render.call(mirror, renderer, scene, camera)
          mesh.visible = entry.shown !== false
          if (this.sky) this.sky.visible = this.settings.skybox !== false
          this.decor.group.visible = true
        }
      }
      if (plane && infinite) this.scene.fog = new THREE.Fog(new THREE.Color(haze[0], haze[1], haze[2]), this.extent * 6, this.extent * 45)
    }
    if (!this.scene.fog) this.scene.fog = null

    this.buildSky(model, m)
    this.buildLights(lights, model)
    this.decor.reset()
    this.camera.fov = model.vis.global.fovy || 45
    this.camera.near = Math.max(1e-4, model.vis.map.znear * this.extent)
    this.camera.far = Math.max(this.camera.near * 10, model.vis.map.zfar * this.extent * 2)
    this.camera.updateProjectionMatrix()
    this.controls.minDistance = this.extent * 0.05
    this.controls.maxDistance = this.extent * 40
    if (previousCamera) this.restoreCamera(previousCamera)
    else this.frameDefault(engine)
    this.applySettings(this.settings)
    this.resize()
    this.sync(engine)
  }

  buildSky(model, m) {
    let texid = -1
    for (let t = 0; t < model.ntex; t++) if (model.tex_type[t] === m.mjtTexture.mjTEXTURE_SKYBOX.value) { texid = t; break }
    let texture = null
    if (texid >= 0) texture = textureFromModel(model, texid, false)
    if (texture) this.owned.push(texture)
    const haze = model.vis.rgba.haze
    const material = new THREE.ShaderMaterial({
      uniforms: {
        tex: { value: texture }, hasTex: { value: texture ? 1 : 0 },
        texel: { value: texture ? new THREE.Vector2(0.5 / texture.image.width, 0.5 / texture.image.height) : new THREE.Vector2() },
        haze: { value: new THREE.Color(haze[0], haze[1], haze[2]) },
        top: { value: new THREE.Color(0.30, 0.40, 0.50) }, bottom: { value: new THREE.Color(0.10, 0.13, 0.16) },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tex; uniform int hasTex; uniform vec2 texel;
        uniform vec3 haze; uniform vec3 top; uniform vec3 bottom;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 c;
          if (hasTex == 1) {
            // MuJoCo's skybox faces, stacked right,left,up,down,front,back; mapping measured against its renderer.
            vec3 a = abs(d); float f; vec2 uv;
            if (a.x >= a.y && a.x >= a.z) { f = d.x > 0.0 ? 0.0 : 1.0; uv = vec2(0.5 + 0.5 * sign(d.x) * d.y / a.x, 0.5 - 0.5 * d.z / a.x); }
            else if (a.y >= a.z) { f = d.y > 0.0 ? 5.0 : 4.0; uv = vec2(0.5 - 0.5 * sign(d.y) * d.x / a.y, 0.5 - 0.5 * d.z / a.y); }
            else { f = d.z > 0.0 ? 2.0 : 3.0; uv = vec2(0.5 + 0.5 * d.x / a.z, 0.5 - 0.5 * sign(d.z) * d.y / a.z); }
            uv = clamp(uv, vec2(texel.x, texel.y * 6.0), vec2(1.0 - texel.x, 1.0 - texel.y * 6.0));
            c = texture2D(tex, vec2(uv.x, (f + uv.y) / 6.0)).rgb;
          } else {
            c = mix(bottom, top, smoothstep(-0.2, 0.6, d.z));
          }
          // The haze band where an infinite floor meets the sky.
          c = mix(c, haze, exp(-abs(d.z) * 30.0) * 0.6);
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthWrite: false, depthTest: false, side: THREE.BackSide, fog: false,
    })
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material)
    sky.frustumCulled = false
    sky.renderOrder = -10
    this.sky = sky
    this.root.add(sky)
    this.owned.push(sky.geometry, material)
  }

  buildLights(lights, model) {
    const extent = this.extent
    const center = new THREE.Vector3(...model.stat.center)
    let ambient = new THREE.Color(0, 0, 0)
    let shadows = 0
    for (const l of lights) {
      ambient.r += l.ambient[0]; ambient.g += l.ambient[1]; ambient.b += l.ambient[2]
      const color = new THREE.Color(l.diffuse[0], l.diffuse[1], l.diffuse[2])
      if (l.headlight) {
        const head = new THREE.DirectionalLight(color, PI)
        head.position.set(0, 0, 0)
        head.target.position.set(0, 0, -1)
        this.camera.add(head, head.target)
        this.lights.push({ light: head, head: true })
        continue
      }
      let light
      if (l.type === 1) {
        light = new THREE.DirectionalLight(color, PI)
        const dir = new THREE.Vector3(...l.dir).normalize()
        light.userData.dir = dir
        light.position.copy(center).addScaledVector(dir, -extent * 6)
        light.target.position.copy(center)
      } else {
        light = new THREE.SpotLight(color, PI, 0, THREE.MathUtils.degToRad(Math.min(89, l.cutoff || 45)), Math.min(1, (l.exponent || 0) / 30 + 0.15), 0)
        light.position.set(...l.pos)
        light.target.position.set(l.pos[0] + l.dir[0], l.pos[1] + l.dir[1], l.pos[2] + l.dir[2])
      }
      if (l.castshadow && shadows < 2) {
        shadows++
        light.castShadow = true
        light.shadow.mapSize.set(2048, 2048)
        light.shadow.bias = -0.0004
        light.shadow.normalBias = 0.01 * extent
        const cam = light.shadow.camera
        if (cam.isOrthographicCamera) {
          const s = extent * 2.2
          cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s
          cam.near = extent * 0.1; cam.far = extent * 14
        } else {
          cam.near = extent * 0.05; cam.far = extent * 30
        }
        cam.updateProjectionMatrix()
      }
      this.root.add(light, light.target)
      this.lights.push({ light, head: false })
    }
    const amb = new THREE.AmbientLight(ambient, PI)
    this.root.add(amb)
    this.lights.push({ light: amb, head: false })
  }

  frameDefault(engine) {
    const c = engine.camera
    const lookat = new THREE.Vector3(c.lookat[0], c.lookat[1], c.lookat[2])
    this.setOrbit(lookat, c.distance, c.azimuth, c.elevation)
  }

  /** MuJoCo's free camera, in its own terms: azimuth and elevation in degrees around lookat. */
  setOrbit(lookat, distance, azimuth, elevation) {
    const az = THREE.MathUtils.degToRad(azimuth), el = THREE.MathUtils.degToRad(elevation)
    const forward = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el))
    this.controls.target.copy(lookat)
    this.camera.position.copy(lookat).addScaledVector(forward, -distance)
    this.controls.update()
  }

  saveCamera() {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray(), mode: this.cameraMode }
  }

  restoreCamera(state) {
    if (!state?.position) return
    this.camera.position.fromArray(state.position)
    this.controls.target.fromArray(state.target)
    this.controls.update()
  }

  dispose() {
    this.decor.hideAll()
    if (this.root) this.scene.remove(this.root)
    for (const { light, head } of this.lights) {
      if (head) { this.camera.remove(light, light.target) }
      light.dispose?.()
      light.shadow?.map?.dispose()
    }
    for (const item of this.owned) item.dispose?.()
    this.owned = []
    this.lights = []
    this.meshes = []
    this.bodies.clear()
    this.root = null
    this.sky = null
    this.floor = null
    this.scene.fog = null
    this.selected = -1
    this.trackLast = null
  }

  // ─── Every frame ────────────────────────────────────────────────────────────────────────────

  /** MuJoCo's body frames into the three.js groups. */
  sync(engine) {
    const d = engine.data
    const xpos = d.xpos, xquat = d.xquat
    for (const [body, group] of this.bodies) {
      group.position.set(xpos[3 * body], xpos[3 * body + 1], xpos[3 * body + 2])
      group.quaternion.set(xquat[4 * body + 1], xquat[4 * body + 2], xquat[4 * body + 3], xquat[4 * body])
    }
  }

  applySettings(settings) {
    this.settings = settings
    const groups = settings.groups ?? [1, 1, 1, 0, 0, 0]
    for (const entry of this.meshes) {
      const shown = Boolean(groups[entry.group])
      entry.shown = shown
      entry.mesh.visible = shown
      const m = entry.material
      m.wireframe = Boolean(settings.wireframe) && !entry.plane
      const see = settings.transparent && entry.body > 0 ? 0.3 : 1
      const opacity = entry.baseOpacity * see
      const reflective = this.floor && entry === this.floor.entry && settings.reflections !== false
      m.opacity = reflective ? opacity * (1 - this.floor.reflectance) : opacity
      m.transparent = opacity < 1 || reflective
      m.depthWrite = !(settings.transparent && entry.body > 0)
      m.needsUpdate = true
    }
    if (this.floor) this.floor.mirror.visible = settings.reflections !== false && Boolean(groups[this.floor.entry.group])
    this.renderer.shadowMap.enabled = settings.shadows !== false
    for (const { light } of this.lights) if (light.shadow && light.castShadow !== undefined && light.userData.shadowCapable !== false) {
      if (light.userData.shadowCapable === undefined) light.userData.shadowCapable = light.castShadow
      light.castShadow = settings.shadows !== false && light.userData.shadowCapable
    }
    for (const entry of this.meshes) entry.material.needsUpdate = true
    if (this.sky) this.sky.visible = settings.skybox !== false
    this.highlight(this.selected)
  }

  highlight(body) {
    this.selected = body
    for (const entry of this.meshes) {
      if (entry.body === body && body > 0) entry.material.emissive.copy(entry.emissive).lerp(HIGHLIGHT, 0.2)
      else entry.material.emissive.copy(entry.emissive)
    }
  }

  /** A pointer position (client px) → a world ray, for mj_ray. */
  rayFrom(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)
    return { origin: raycaster.ray.origin.toArray(), direction: raycaster.ray.direction.toArray(), ray: raycaster.ray }
  }

  /** Keep the shadow-casting directional lights over whatever the camera is looking at. */
  followShadows() {
    const target = this.controls.target
    for (const { light } of this.lights) {
      if (!light.isDirectionalLight || !light.userData.dir) continue
      light.position.copy(target).addScaledVector(light.userData.dir, -this.extent * 6)
      light.target.position.copy(target)
      light.target.updateMatrixWorld()
    }
  }

  setCameraMode(mode, engine) {
    const was = this.cameraMode
    if (was.kind === 'free' && mode.kind !== 'free') this.freeCamera = this.saveCamera()
    this.cameraMode = mode
    this.trackLast = null
    this.controls.enabled = mode.kind !== 'fixed'
    if (mode.kind !== 'fixed') {
      this.camera.fov = engine?.model?.vis.global.fovy || 45
      this.camera.updateProjectionMatrix()
      if (was.kind === 'fixed' && this.freeCamera) this.restoreCamera(this.freeCamera)
    }
  }

  updateCamera(engine) {
    const mode = this.cameraMode
    const d = engine.data
    if (mode.kind === 'track' && mode.body > 0) {
      const b = mode.body
      const com = new THREE.Vector3(d.subtree_com[3 * b], d.subtree_com[3 * b + 1], d.subtree_com[3 * b + 2])
      if (this.trackLast) {
        const delta = com.clone().sub(this.trackLast)
        this.camera.position.add(delta)
        this.controls.target.add(delta)
      } else {
        const delta = com.clone().sub(this.controls.target)
        this.camera.position.add(delta)
        this.controls.target.copy(com)
      }
      this.trackLast = com
    } else if (mode.kind === 'fixed') {
      const c = mode.camera
      const R = d.cam_xmat
      const o = 9 * c
      this.camera.position.set(d.cam_xpos[3 * c], d.cam_xpos[3 * c + 1], d.cam_xpos[3 * c + 2])
      const basis = new THREE.Matrix4().set(R[o], R[o + 1], R[o + 2], 0, R[o + 3], R[o + 4], R[o + 5], 0, R[o + 6], R[o + 7], R[o + 8], 0, 0, 0, 0, 1)
      this.camera.quaternion.setFromRotationMatrix(basis)
      const fovy = engine.model.cam_fovy[c]
      if (fovy && Math.abs(this.camera.fov - fovy) > 1e-6) { this.camera.fov = fovy; this.camera.updateProjectionMatrix() }
    }
    if (mode.kind !== 'fixed') this.controls.update()
  }

  /** Keep MuJoCo's abstract camera where ours is, so perturbation scale matches what is on screen. */
  syncMjCamera(engine) {
    const c = engine.camera
    if (!c) return
    const t = this.controls.target
    const offset = this.camera.position.clone().sub(t)
    const distance = offset.length()
    c.lookat[0] = t.x; c.lookat[1] = t.y; c.lookat[2] = t.z
    c.distance = distance
    c.azimuth = THREE.MathUtils.radToDeg(Math.atan2(-offset.y, -offset.x))
    c.elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(-offset.z / Math.max(distance, 1e-9), -1, 1)))
  }

  render() {
    this.followShadows()
    this.renderer.render(this.scene, this.camera)
  }
}

// ─── Decorations: mjvGeoms from mjv_updateScene ─────────────────────────────────────────────────

const UNIT = {
  sphere: new THREE.SphereGeometry(1, 18, 12),
  box: new THREE.BoxGeometry(2, 2, 2),
  cylinder: new THREE.CylinderGeometry(1, 1, 2, 18, 1).rotateX(PI / 2),
  shaft: new THREE.CylinderGeometry(1, 1, 1, 12, 1).rotateX(PI / 2).translate(0, 0, 0.5),
  cone: new THREE.ConeGeometry(1, 1, 16, 1).rotateX(PI / 2).translate(0, 0, 0.5),
  edges: new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
}

class Decor {
  constructor(scene) {
    this.group = new THREE.Group()
    this.group.name = 'decor'
    scene.add(this.group)
    this.pools = new Map()
    this.used = new Map()
    this.m = new THREE.Matrix4()
    this.s = new THREE.Matrix4()
    this.v = new THREE.Vector3()
  }

  reset() { this.hideAll() }

  hideAll() { for (const pool of this.pools.values()) for (const item of pool) item.visible = false }

  take(kind) {
    let pool = this.pools.get(kind)
    if (!pool) { pool = []; this.pools.set(kind, pool) }
    const n = this.used.get(kind) ?? 0
    this.used.set(kind, n + 1)
    if (pool[n]) { pool[n].visible = true; return pool[n] }
    const material = () => new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 40, specular: 0x222222, transparent: true, fog: false })
    let object
    if (kind === 'arrow' || kind === 'arrow2') {
      object = new THREE.Group()
      const mat = material()
      const shaft = new THREE.Mesh(UNIT.shaft, mat)
      const head = new THREE.Mesh(UNIT.cone, mat)
      object.add(shaft, head)
      if (kind === 'arrow2') object.add(new THREE.Mesh(UNIT.cone, mat))
      for (const child of object.children) child.matrixAutoUpdate = false
      object.userData.material = mat
    } else if (kind === 'capsule') {
      object = new THREE.Group()
      const mat = material()
      object.add(new THREE.Mesh(UNIT.cylinder, mat), new THREE.Mesh(UNIT.sphere, mat), new THREE.Mesh(UNIT.sphere, mat))
      for (const child of object.children) child.matrixAutoUpdate = false
      object.userData.material = mat
    } else if (kind === 'linebox') {
      const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, fog: false })
      object = new THREE.LineSegments(UNIT.edges, mat)
      object.userData.material = mat
    } else {
      const mat = material()
      object = new THREE.Mesh(kind === 'box' ? UNIT.box : kind === 'cylinder' ? UNIT.cylinder : UNIT.sphere, mat)
      object.userData.material = mat
    }
    object.matrixAutoUpdate = false
    object.frustumCulled = false
    object.renderOrder = 2
    pool.push(object)
    this.group.add(object)
    return object
  }

  /** Draw every decoration geom in the MjvScene; hide what was drawn last frame and is gone now. */
  draw(engine, extent) {
    const m = engine.mujoco
    const scn = engine.scene
    this.used.clear()
    const vec = scn.geoms
    const T = m.mjtGeom
    const lineWidth = extent * 0.0025
    for (let i = 0; i < scn.ngeom; i++) {
      const g = vec.get(i)
      try {
        const type = g.type
        const kind = type === T.mjGEOM_SPHERE.value || type === T.mjGEOM_ELLIPSOID.value ? 'sphere'
          : type === T.mjGEOM_BOX.value ? 'box'
          : type === T.mjGEOM_CYLINDER.value ? 'cylinder'
          : type === T.mjGEOM_CAPSULE.value ? 'capsule'
          : type === T.mjGEOM_ARROW.value || type === T.mjGEOM_ARROW1.value ? 'arrow'
          : type === T.mjGEOM_ARROW2.value ? 'arrow2'
          : type === T.mjGEOM_LINE.value ? 'line'
          : type === T.mjGEOM_LINEBOX.value ? 'linebox'
          : null
        if (!kind) continue
        const pos = g.pos, R = g.mat, size = g.size, rgba = g.rgba
        const object = this.take(kind === 'line' ? 'arrow' : kind)
        this.m.set(R[0], R[1], R[2], pos[0], R[3], R[4], R[5], pos[1], R[6], R[7], R[8], pos[2], 0, 0, 0, 1)
        const mat = object.userData.material
        mat.color.setRGB(rgba[0], rgba[1], rgba[2])
        mat.opacity = rgba[3]
        mat.depthWrite = rgba[3] >= 1
        if (kind === 'sphere' || kind === 'box' || kind === 'cylinder' || kind === 'linebox') {
          object.matrix.copy(this.m).multiply(this.s.makeScale(size[0], size[1], size[2]))
        } else if (kind === 'capsule') {
          object.matrix.copy(this.m)
          const [cyl, a, b] = object.children
          cyl.matrix.makeScale(size[0], size[1], size[2])
          a.matrix.makeScale(size[0], size[0], size[0]).setPosition(0, 0, size[2])
          b.matrix.makeScale(size[0], size[0], size[0]).setPosition(0, 0, -size[2])
        } else {
          // Arrows exactly as MuJoCo's renderer (render_gl3.c) draws them from an mjvGeom: along local z,
          // a shaft of radius size[0] over L/3 and a cone over the next L/6 (L = size[2]); the cone is
          // 1.75× the shaft for ARROW, as wide as it for ARROW1; ARROW2 is centred, heads both ways.
          // A LINE runs the full size[2], a hairline.
          object.matrix.copy(this.m)
          const L = Math.max(1e-6, size[2])
          const [shaft, head, tail] = object.children
          if (kind === 'line') {
            shaft.matrix.makeScale(lineWidth, lineWidth, L)
            head.visible = false
          } else if (kind === 'arrow2') {
            const r = 1.75 * size[0]
            shaft.matrix.makeScale(size[0], size[1], (2 * L) / 3).setPosition(0, 0, -L / 3)
            head.visible = true
            head.matrix.makeScale(r, 1.75 * size[1], L / 6).setPosition(0, 0, L / 3)
            tail.matrix.makeRotationX(PI).scale(this.v.set(r, 1.75 * size[1], L / 6)).setPosition(0, 0, -L / 3)
          } else {
            const wedge = type === T.mjGEOM_ARROW1.value ? 1 : 1.75
            shaft.matrix.makeScale(size[0], size[1], L / 3)
            head.visible = true
            head.matrix.makeScale(wedge * size[0], wedge * size[1], L / 6).setPosition(0, 0, L / 3)
          }
        }
      } finally {
        g.delete()
      }
    }
    vec.delete()
    for (const [kind, pool] of this.pools) {
      const n = this.used.get(kind) ?? 0
      for (let i = n; i < pool.length; i++) pool[i].visible = false
    }
  }
}

// ─── Geometry out of the compiled model ─────────────────────────────────────────────────────────

/**
 * A mesh as three.js sees it. MuJoCo's arrays are views straight into the WASM heap and are
 * invalidated the moment it grows, so every buffer is copied out before it reaches a BufferAttribute.
 */
function meshGeometry(model, id, withUv) {
  const va = model.mesh_vertadr[id], vn = model.mesh_vertnum[id]
  const na = model.mesh_normaladr[id], nn = model.mesh_normalnum[id]
  const fa = model.mesh_faceadr[id], fn = model.mesh_facenum[id]
  const vert = model.mesh_vert.subarray(va * 3, (va + vn) * 3)
  const norm = model.mesh_normal.subarray(na * 3, (na + nn) * 3)
  const face = model.mesh_face.subarray(fa * 3, (fa + fn) * 3)
  const fnorm = model.mesh_facenormal.subarray(fa * 3, (fa + fn) * 3)
  const geometry = new THREE.BufferGeometry()

  let aligned = nn === vn && !withUv
  for (let k = 0; aligned && k < face.length; k++) if (face[k] !== fnorm[k]) aligned = false
  if (aligned) {
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vert), 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(norm), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(face), 1))
  } else {
    const position = new Float32Array(face.length * 3)
    const normal = new Float32Array(face.length * 3)
    for (let k = 0; k < face.length; k++) {
      const v = face[k] * 3, n = fnorm[k] * 3, o = k * 3
      position[o] = vert[v]; position[o + 1] = vert[v + 1]; position[o + 2] = vert[v + 2]
      normal[o] = norm[n]; normal[o + 1] = norm[n + 1]; normal[o + 2] = norm[n + 2]
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
    if (withUv) {
      const ta = model.mesh_texcoordadr[id], tn = model.mesh_texcoordnum[id]
      const tc = model.mesh_texcoord.subarray(ta * 2, (ta + tn) * 2)
      const ftc = model.mesh_facetexcoord.subarray(fa * 3, (fa + fn) * 3)
      const uv = new Float32Array(face.length * 2)
      for (let k = 0; k < face.length; k++) { const t = ftc[k] * 2; uv[2 * k] = tc[t]; uv[2 * k + 1] = tc[t + 1] }
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    }
  }
  geometry.computeBoundingSphere()
  return geometry
}

/** A primitive geom, in MuJoCo's convention: half-sizes, Z the axis of revolution. */
function primitive(T, type, size) {
  switch (type) {
    case T.mjGEOM_SPHERE.value: return new THREE.SphereGeometry(size[0], 36, 18)
    case T.mjGEOM_CAPSULE.value: return new THREE.CapsuleGeometry(size[0], 2 * size[1], 10, 28).rotateX(PI / 2)
    case T.mjGEOM_CYLINDER.value: return new THREE.CylinderGeometry(size[0], size[0], 2 * size[1], 36).rotateX(PI / 2)
    case T.mjGEOM_BOX.value: return new THREE.BoxGeometry(2 * size[0], 2 * size[1], 2 * size[2])
    case T.mjGEOM_ELLIPSOID.value: return new THREE.SphereGeometry(1, 36, 18).scale(size[0], size[1], size[2])
    default: return null
  }
}

function hfieldGeometry(model, id) {
  if (id < 0) return null
  try {
    const nrow = model.hfield_nrow[id], ncol = model.hfield_ncol[id]
    const [sx, sy, sz, base] = [0, 1, 2, 3].map((k) => model.hfield_size[4 * id + k])
    const adr = model.hfield_adr[id]
    const data = model.hfield_data
    const geometry = new THREE.PlaneGeometry(2 * sx, 2 * sy, ncol - 1, nrow - 1)
    const pos = geometry.attributes.position
    for (let r = 0; r < nrow; r++) for (let c = 0; c < ncol; c++) {
      // PlaneGeometry rows run top (+y) to bottom; MuJoCo's row 0 is at -y.
      const vi = (nrow - 1 - r) * ncol + c
      pos.setZ(vi, data[adr + r * ncol + c] * sz)
    }
    geometry.translate(0, 0, 0)
    geometry.computeVertexNormals()
    void base
    return geometry
  } catch { return null }
}

/** A texture out of tex_data; RGB is widened to RGBA. Row 0 is the image's top row, as MuJoCo stores it. */
function textureFromModel(model, texid, repeat = true) {
  try {
    const w = model.tex_width[texid], h = model.tex_height[texid], ch = model.tex_nchannel[texid]
    const adr = Number(model.tex_adr[texid])
    const src = model.tex_data.subarray(adr, adr + w * h * ch)
    const rgba = new Uint8Array(w * h * 4)
    for (let i = 0, j = 0; i < w * h; i++, j += ch) {
      const o = i * 4
      if (ch === 1) { rgba[o] = rgba[o + 1] = rgba[o + 2] = src[j]; rgba[o + 3] = 255 }
      else { rgba[o] = src[j]; rgba[o + 1] = src[j + 1]; rgba[o + 2] = src[j + 2]; rgba[o + 3] = ch === 4 ? src[j + 3] : 255 }
    }
    const texture = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat)
    texture.colorSpace = THREE.NoColorSpace
    if (repeat) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      texture.generateMipmaps = true
      texture.minFilter = THREE.LinearMipmapLinearFilter
    } else {
      texture.generateMipmaps = false
      texture.minFilter = THREE.LinearFilter
    }
    texture.magFilter = THREE.LinearFilter
    texture.needsUpdate = true
    return texture
  } catch { return null }
}

function frac(x) { return x - Math.floor(x) }
