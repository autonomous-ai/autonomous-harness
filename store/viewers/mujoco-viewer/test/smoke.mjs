// The WASM bindings are a work in progress upstream, and a renamed method is a blank pane. This is
// the smallest test that would catch one: load the module, mount the filesystem the pane mounts,
// compile a model out of it, and exercise exactly what the pane calls — stepping, replay, the
// geometry and texture arrays it draws from, mjv_updateScene's decorations and lights, mj_ray
// picking, simulate's perturbation, contact forces, names, and the workarounds for what the
// bindings get wrong (NULL names, boolean arrays).
//
//   npm test
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const loadMujoco = (await import(join(here, '..', 'node_modules/@mujoco/mujoco/mujoco.js'))).default

const XML = `<mujoco model="smoke">
  <option timestep="0.002"/>
  <visual><headlight ambient=".3 .3 .3" diffuse=".6 .6 .6"/><rgba haze=".15 .25 .35 1"/></visual>
  <asset>
    <texture type="skybox" builtin="gradient" rgb1=".3 .5 .7" rgb2="0 0 0" width="32" height="192"/>
    <texture name="grid" type="2d" builtin="checker" rgb1=".2 .3 .4" rgb2=".1 .2 .3" width="64" height="64"/>
    <material name="grid" texture="grid" texrepeat="5 5" texuniform="true" reflectance=".2"/>
  </asset>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1" directional="true"/>
    <geom name="floor" type="plane" size="0 0 .05" material="grid"/>
    <camera name="side" pos="0 -2 .5" xyaxes="1 0 0 0 0 1"/>
    <body name="ball" pos="0 0 1">
      <freejoint/>
      <geom type="capsule" size=".1 .2" rgba=".8 .2 .2 1"/>
      <site name="imu" size=".01"/>
    </body>
    <body name="arm" pos="1 0 .5">
      <joint name="hinge" type="hinge" axis="0 1 0" range="-1 1"/>
      <geom type="box" size=".05 .05 .3" pos="0 0 .3"/>
    </body>
  </worldbody>
  <actuator><position name="servo" joint="hinge" kp="20" ctrlrange="-1 1"/></actuator>
  <sensor><accelerometer name="acc" site="imu"/><jointpos name="angle" joint="hinge"/></sensor>
  <keyframe><key name="home" qpos="0 0 .5 1 0 0 0 .3" ctrl=".3"/></keyframe>
</mujoco>`

const mujoco = await loadMujoco()

// The pane's filesystem: MEMFS at /working, every model file written in at its own relative path.
mujoco.FS.mkdir('/working')
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working')
mujoco.FS.mkdir('/working/scenes')
mujoco.FS.writeFile('/working/scenes/smoke.xml', new TextEncoder().encode(XML))

const model = mujoco.MjModel.mj_loadXML('/working/scenes/smoke.xml')
const data = new mujoco.MjData(model)

assert.equal(model.nq, 8, 'a free joint is 7 qpos, a hinge 1')
assert.equal(model.nbody, 3)
assert.equal(model.nkey, 1)
assert.ok(model.opt.timestep > 0)

// A compile error arrives as a JS Error carrying MuJoCo's message; the pane shows it verbatim.
mujoco.FS.writeFile('/working/scenes/bad.xml', new TextEncoder().encode('<mujoco><worldbody><body></worldbody></mujoco>'))
assert.throws(() => mujoco.MjModel.mj_loadXML('/working/scenes/bad.xml'), /XML|Error/)

// Keyframe, then the state the pane draws: one xpos triple and one xquat quad per body.
mujoco.mj_resetDataKeyframe(model, data, 0)
mujoco.mj_forward(model, data)
assert.equal(data.xpos.length, model.nbody * 3)
assert.equal(data.xquat.length, model.nbody * 4)
assert.equal(data.xpos[5].toFixed(3), '0.500', 'the keyframe put the ball at z = 0.5')
assert.equal(data.ctrl[0].toFixed(2), '0.30', 'and set its ctrl')

// Live mode: steps of physics, and the ball has fallen; energy on request.
model.opt.enableflags |= mujoco.mjtEnableBit.mjENBL_ENERGY.value
const before = data.xpos[5]
for (let i = 0; i < 50; i++) mujoco.mj_step(model, data)
assert.ok(data.time > 0, 'time advances')
assert.ok(data.xpos[5] < before, 'gravity pulls the ball down')
assert.equal(data.energy.length, 2)
assert.ok(Number.isFinite(data.energy[0]))

// Replay mode: a whole state written straight in, then forward kinematics.
data.qpos.set([0, 0, 2.25, 1, 0, 0, 0, 0])
data.qvel.fill(0)
data.qacc_warmstart.fill(0)
mujoco.mj_forward(model, data)
assert.equal(data.xpos[5].toFixed(3), '2.250', 'writing qpos moves the body')
const diff = new mujoco.DoubleBuffer(model.nv)
mujoco.mj_differentiatePos(model, diff, 0.1, [0, 0, 1, 1, 0, 0, 0, 0], [0, 0, 1.1, 1, 0, 0, 0, 0])
assert.equal(diff.GetView()[2].toFixed(3), '1.000', 'velocities out of two frames of qpos')
diff.delete()

// Names: read from model.names at name_*adr. mj_id2name turns an unnamed object's NULL into junk.
const nameAt = (adr) => { let s = ''; for (let i = adr; model.names[i]; i++) s += String.fromCharCode(model.names[i]); return s }
assert.equal(nameAt(model.name_bodyadr[1]), 'ball')
assert.equal(nameAt(model.name_jntadr[0]), '', 'the free joint has no name, and the buffer says so')
assert.equal(nameAt(model.name_jntadr[1]), 'hinge')
assert.equal(nameAt(model.name_actuatoradr[0]), 'servo')
assert.equal(nameAt(model.name_sensoradr[1]), 'angle')
assert.equal(nameAt(model.name_camadr[0]), 'side')
assert.equal(nameAt(model.name_keyadr[0]), 'home')

// What the panel lists, and the arrays behind it.
for (const field of ['jnt_type', 'jnt_range', 'jnt_qposadr', 'jnt_dofadr', 'jnt_bodyid', 'body_parentid', 'body_mass', 'body_subtreemass',
  'actuator_ctrlrange', 'actuator_trntype', 'actuator_trnid', 'sensor_type', 'sensor_adr', 'sensor_dim', 'sensor_objtype', 'sensor_objid',
  'site_bodyid', 'cam_fovy', 'key_ctrl', 'key_qpos', 'key_time', 'actuator_gainprm', 'geom_group', 'geom_matid', 'geom_dataid']) {
  assert.ok(ArrayBuffer.isView(model[field]), `model.${field} is gone from the bindings`)
}
assert.equal(model.jnt_type[0], mujoco.mjtJoint.mjJNT_FREE.value)
assert.equal(model.actuator_trntype[0], mujoco.mjtTrn.mjTRN_JOINT.value)
assert.ok(mujoco.mjtSensor.mjSENS_ACCELEROMETER.value >= 0)
assert.equal(data.sensordata.length, 4)
// Boolean arrays do not survive these bindings; the pane never reads them (it infers "limited" from ranges).
assert.throws(() => model.jnt_limited, /unknown type/, 'if jnt_limited reads now, the workaround can go')

// Geometry and textures the stage builds from.
assert.equal(model.geom_type[0], mujoco.mjtGeom.mjGEOM_PLANE.value)
assert.equal(model.geom_type[1], mujoco.mjtGeom.mjGEOM_CAPSULE.value)
assert.equal(model.geom_size[3].toFixed(2), '0.10', 'capsule radius')
for (const field of ['mesh_vert', 'mesh_normal', 'mesh_face', 'mesh_facenormal', 'mesh_vertadr', 'mesh_vertnum', 'mesh_faceadr', 'mesh_facenum',
  'mesh_normaladr', 'mesh_normalnum', 'mesh_texcoord', 'mesh_texcoordadr', 'mesh_texcoordnum', 'mesh_facetexcoord',
  'tex_type', 'tex_width', 'tex_height', 'tex_nchannel', 'tex_adr', 'tex_data', 'mat_texid', 'mat_texrepeat', 'mat_rgba',
  'mat_reflectance', 'mat_specular', 'mat_shininess', 'mat_emission', 'hfield_nrow', 'hfield_size']) {
  assert.ok(model[field] !== undefined, `model.${field} is gone from the bindings`)
}
assert.equal(model.ntex, 2)
assert.equal(model.tex_type[0], mujoco.mjtTexture.mjTEXTURE_SKYBOX.value)
assert.equal(model.tex_height[0], 6 * model.tex_width[0], 'a skybox is six faces stacked')
assert.ok(model.mat_texid.length % model.nmat === 0)
assert.ok(model.vis.global.fovy > 0 && model.vis.map.znear > 0 && model.vis.rgba.haze.length === 4)
assert.equal(model.stat.center.length, 3)

// mjv_updateScene: one full pass (lights and per-geom texture flags), then decorations.
const option = new mujoco.MjvOption(); mujoco.mjv_defaultOption(option)
const perturb = new mujoco.MjvPerturb(); mujoco.mjv_defaultPerturb(perturb)
const camera = new mujoco.MjvCamera(); mujoco.mjv_defaultFreeCamera(model, camera)
const scene = new mujoco.MjvScene(model, 1000)
mujoco.mj_resetDataKeyframe(model, data, 0)
mujoco.mj_forward(model, data)
mujoco.mjv_updateScene(model, data, option, perturb, camera, mujoco.mjtCatBit.mjCAT_ALL.value, scene)
assert.ok(scene.nlight >= 2, 'the headlight and the model light')
const lights = scene.lights
const head = lights.get(0)
assert.equal(head.headlight, 1)
assert.equal(head.ambient[0].toFixed(1), '0.3')
head.delete()
const sun = lights.get(1)
assert.equal(sun.type, mujoco.mjtLightType.mjLIGHT_DIRECTIONAL.value)
assert.equal(sun.dir[2].toFixed(1), '-1.0', 'lights have a pose only after mj_forward')
sun.delete(); lights.delete()
let floorFlags = null
const all = scene.geoms
for (let i = 0; i < scene.ngeom; i++) { const g = all.get(i); if (g.objtype === mujoco.mjtObj.mjOBJ_GEOM.value && g.objid === 0) floorFlags = { texuniform: g.texuniform }; g.delete() }
all.delete()
assert.deepEqual(floorFlags, { texuniform: 1 }, 'texuniform comes from the scene pass')

// Contacts on: let the ball land, then decorations only.
for (let i = 0; i < 400; i++) mujoco.mj_step(model, data)
assert.ok(data.ncon > 0, 'the ball is on the floor')
option.flags.fill(0)
option.flags[mujoco.mjtVisFlag.mjVIS_CONTACTPOINT.value] = 1
option.flags[mujoco.mjtVisFlag.mjVIS_CONTACTFORCE.value] = 1
option.flags[mujoco.mjtVisFlag.mjVIS_JOINT.value] = 1
option.frame = mujoco.mjtFrame.mjFRAME_BODY.value
mujoco.mjv_updateScene(model, data, option, perturb, camera, mujoco.mjtCatBit.mjCAT_DECOR.value, scene)
assert.ok(scene.ngeom > data.ncon, 'contact points, forces, joint axes, frames')
const decor = scene.geoms
const g0 = decor.get(0)
assert.equal(g0.pos.length, 3); assert.equal(g0.mat.length, 9); assert.equal(g0.size.length, 3); assert.equal(g0.rgba.length, 4)
g0.delete(); decor.delete()
const force = new mujoco.DoubleBuffer(6)
mujoco.mj_contactForce(model, data, 0, force)
assert.ok(Math.abs(force.GetView()[0]) > 0, 'a normal force')
force.delete()

// Picking: mj_ray from above hits the ball.
const hit = new mujoco.IntBuffer(1)
const ballX = data.xpos[3], ballY = data.xpos[4]
const dist = mujoco.mj_ray(model, data, [ballX, ballY, 3], [0, 0, -1], [1, 1, 1, 0, 0, 0], 1, -1, hit, null)
assert.ok(dist > 0)
assert.equal(model.geom_bodyid[hit.GetView()[0]], 1, 'the ray found the ball')
hit.delete()

// Perturbation, as simulate does it: select, init, move the reference, apply the spring.
perturb.select = 1
perturb.localpos.set([0, 0, 0])
mujoco.mjv_initPerturb(model, data, scene, perturb)
perturb.active = mujoco.mjtPertBit.mjPERT_TRANSLATE.value
perturb.refselpos[2] += 0.5
perturb.refpos[2] += 0.5
data.xfrc_applied.fill(0)
mujoco.mjv_applyPerturbForce(model, data, perturb)
assert.ok(data.xfrc_applied[6 + 2] > 0, 'the spring pulls the ball up')
perturb.active = mujoco.mjtPertBit.mjPERT_ROTATE.value
mujoco.mjv_applyPerturbPose(model, data, perturb, 1)
option.flags[mujoco.mjtVisFlag.mjVIS_PERTFORCE.value] = 1
mujoco.mjv_updateScene(model, data, option, perturb, camera, mujoco.mjtCatBit.mjCAT_DECOR.value, scene)

// Warnings (MuJoCo resets on instability). data.warning is MjData's own storage: delete what get()
// returns, never the vector itself — that frees MjData's memory and data.delete() aborts later.
for (let i = 0; i < 3; i++) {
  const bad = data.warning.get(mujoco.mjtWarning.mjWARN_BADQACC.value)
  assert.equal(typeof bad.number, 'number')
  bad.delete()
}

// Patching a compiled model, as a rollout's model_patch does.
model.actuator_gainprm[0] = 40
model.opt.timestep = 0.001
mujoco.mj_setConst(model, data)
assert.equal(model.opt.timestep, 0.001)
assert.equal(model.actuator_gainprm[0], 40)

// Reset, the pane's Reset button.
mujoco.mj_resetData(model, data)
assert.equal(data.time, 0)

for (const handle of [scene, camera, perturb, option, data, model]) handle.delete()
console.log('ok   mujoco wasm: load, step, replay, names, geometry, textures, lights, decorations, picking, perturbation')
