// The WASM bindings are a work in progress upstream, and a renamed method is a blank pane. This is
// the smallest test that would catch one: load the module, mount the filesystem the pane mounts,
// compile a model out of it, step it, and read back exactly the arrays the pane reads every frame.
//
//   npm test
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const loadMujoco = (await import(join(here, '..', 'node_modules/@mujoco/mujoco/mujoco.js'))).default

const XML = `<mujoco model="smoke">
  <worldbody>
    <light pos="0 0 3"/>
    <geom name="floor" type="plane" size="5 5 .1"/>
    <body name="ball" pos="0 0 1">
      <joint type="free"/>
      <geom type="capsule" size=".1 .2" rgba=".8 .2 .2 1"/>
    </body>
  </worldbody>
  <keyframe><key name="home" qpos="0 0 .5 1 0 0 0"/></keyframe>
</mujoco>`

const mujoco = await loadMujoco()

// The pane's filesystem: MEMFS at /working, every model file written in at its own relative path.
mujoco.FS.mkdir('/working')
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working')
mujoco.FS.mkdir('/working/scenes')
mujoco.FS.writeFile('/working/scenes/smoke.xml', new TextEncoder().encode(XML))

const model = mujoco.MjModel.mj_loadXML('/working/scenes/smoke.xml')
const data = new mujoco.MjData(model)

assert.equal(model.nq, 7, 'a free joint is 7 qpos')
assert.equal(model.nbody, 2, 'world + ball')
assert.equal(model.ngeom, 2)
assert.equal(model.nkey, 1)
assert.ok(model.opt.timestep > 0)

// The keyframe, then the state the pane draws: one xpos triple and one xquat quad per body.
mujoco.mj_resetDataKeyframe(model, data, 0)
mujoco.mj_forward(model, data)
assert.equal(data.xpos.length, model.nbody * 3, 'xpos is nbody × 3')
assert.equal(data.xquat.length, model.nbody * 4, 'xquat is nbody × 4')
assert.equal(data.xpos[5].toFixed(3), '0.500', 'the keyframe put the ball at z = 0.5')

// Live mode: ten steps of physics, and the ball has fallen.
const before = data.xpos[5]
for (let i = 0; i < 10; i++) mujoco.mj_step(model, data)
assert.ok(data.time > 0, 'time advances')
assert.ok(data.xpos[5] < before, 'gravity pulls the ball down')

// Replay mode: a qpos row written straight into the live view, then forward kinematics.
const qpos = data.qpos
assert.equal(qpos.length, model.nq)
qpos[2] = 2.25
mujoco.mj_forward(model, data)
assert.equal(data.xpos[5].toFixed(3), '2.250', 'writing qpos moves the body')

// Geometry the pane reads out of the compiled model.
assert.equal(model.geom_type[0], mujoco.mjtGeom.mjGEOM_PLANE.value)
assert.equal(model.geom_type[1], mujoco.mjtGeom.mjGEOM_CAPSULE.value)
assert.equal(model.geom_size[3].toFixed(2), '0.10', 'capsule radius')
assert.equal(model.geom_size[4].toFixed(2), '0.20', 'capsule half-length')
assert.equal(model.geom_bodyid[1], 1)
assert.equal(model.geom_rgba.length, model.ngeom * 4)
assert.equal(model.geom_group.length, model.ngeom)
for (const field of ['mesh_vert', 'mesh_normal', 'mesh_face', 'mesh_facenormal', 'mesh_vertadr', 'mesh_vertnum', 'mesh_faceadr', 'mesh_facenum', 'mesh_normaladr', 'mesh_normalnum']) {
  assert.ok(model[field] !== undefined, `model.${field} is gone from the bindings`)
}

// Reset, the pane's Reset button.
mujoco.mj_resetData(model, data)
assert.equal(data.time, 0)

data.delete()
model.delete()
console.log('ok   mujoco wasm: load, step, replay, geometry')
