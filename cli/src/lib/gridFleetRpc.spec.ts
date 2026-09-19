import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GridFleetRpc, GridOutputCapture, parseGridFleetRequest } from './gridFleetRpc.js'
import { encryptDownFrame, encryptRpcResult } from './e2ee/applicationFrames.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'grid-fleet-rpc-')); directories.push(dir)
  const file = join(dir,'grid'); writeFileSync(file,`#!${process.execPath}\n${body}\n`); chmodSync(file,0o700)
  return new GridFleetRpc({ ...process.env, HARNESS_GRID_BIN: file })
}
describe('paired Grid fleet commands', () => {
  it('validates bounded argv and runtime, rejecting NULs and command strings', () => {
    expect(parseGridFleetRequest({args:['--remote','chat','a prompt\nwith lines']})).toEqual({args:['--remote','chat','a prompt\nwith lines'],timeoutMs:30000})
    for (const payload of [{args:'grid ls'},{args:[]},{args:['x\0y']},{args:['x'.repeat(17000)]},{args:['ls'],timeoutMs:1_800_001},{args:['ls'],timeoutMs:-1}]) expect(parseGridFleetRequest(payload)).toBeNull()
  })
  it('preserves argument boundaries and exit status without shell interpretation', async () => {
    const rpc=fixture('console.log(JSON.stringify(process.argv.slice(2)));process.exit(7)')
    const args=['--local','chat','$(echo secret); `pwd`',"single'quote",'line\nline']
    const result=await rpc.run('owner','one',{args,timeoutMs:3000})
    expect(result.code).toBe(7);expect(result.ok).toBe(false);expect(JSON.parse(result.stdout)).toEqual(args)
  })
  it('keeps timeout failures even when a child handles SIGTERM with exit zero', async () => {
    const rpc=fixture("process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)")
    const result=await rpc.run('owner','timeout',{args:['join'],timeoutMs:200})
    expect(result).toMatchObject({ok:false,code:124});expect(result.error).toContain('timed out')
  })
  it('applies explicit thinking to this child only, without allowing arbitrary environment input', async () => {
    expect(parseGridFleetRequest({args:['join'],thinking:'off'})).toBeNull()
    const rpc=fixture("console.log(process.env.LLAMA_ARG_CHAT_TEMPLATE_KWARGS || 'unset')")
    expect((await rpc.run('owner','off',{args:['join'],timeoutMs:3000,thinking:false})).stdout.trim()).toBe('{"enable_thinking":false}')
    expect((await rpc.run('owner','default',{args:['join'],timeoutMs:3000})).stdout.trim()).toBe('unset')
  })
  it('owns cancellation by connection and refuses duplicate live requests', async () => {
    const rpc=fixture('setInterval(()=>{},1000)')
    const pending=rpc.run('owner','job',{args:['pull'],timeoutMs:5000})
    expect(rpc.cancel('stranger','job')).toBe(false)
    expect((await rpc.run('owner','job',{args:['pull'],timeoutMs:5000})).error).toContain('already running')
    expect(rpc.cancel('owner','job')).toBe(true)
    expect(await pending).toMatchObject({ok:false,code:124})
  })
  it('fails loud on oversized output instead of returning a truncated successful JSON result', async () => {
    const result=await fixture("process.stdout.write('x'.repeat(600000));setInterval(()=>{},1000)").run('owner','large',{args:['models'],timeoutMs:3000})
    expect(result).toMatchObject({ok:false,code:124});expect(result.error).toContain('512 KiB')
  })
  it('keeps download progress bounded while retaining completed diagnostics', async () => {
    const output=new GridOutputCapture()
    output.append('Downloading model\n\rfirst');output.append('\r');output.append('last\r');output.append('\nDone\n')
    expect(output.text).toBe('Downloading model\nlast\nDone\n')
    const result=await fixture("for(let i=0;i<50000;i++)process.stderr.write('\\r['+i+'/50000] downloading model');console.log('saved model.gguf')").run('owner','progress',{args:['pull'],timeoutMs:10000})
    expect(result).toMatchObject({ok:true,code:0});expect(result.stdout).toBe('saved model.gguf\n')
    expect(result.stderr).toBe('[49999/50000] downloading model')
  })
  it('requires pairwise encryption in both directions for every fleet RPC', () => {
    for(const type of ['grid_fleet_capabilities','grid_fleet_run','grid_fleet_cancel']) {
      expect(encryptDownFrame(type)).toBe(true);expect(encryptRpcResult(`${type}_result`)).toBe(true)
    }
  })
})
