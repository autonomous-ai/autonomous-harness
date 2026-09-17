// The schematic's netlist: out/<top>_schematic.json, which `yosys prep` wrote with the hierarchy
// kept. Three things come out of it here:
//
//   hierarchy(netlist)          the instance tree from the top module down, for navigation
//   moduleForRender(netlist, m) one module as a netlist netlistsvg will draw on its own
//   moduleIndex(netlist, m)     what hovering in that drawing needs: net names by bit, cell types
//                               and source lines, which instances open another module
//
// Yosys names a parameterised module after its parameters — `$paramod\breathe\STEP_DIV=s32'0…0100`,
// or `$paramod$ac1dfc5b…\uart_tx` when they do not fit. Those are what the netlist says, and they
// stay the keys; what a person reads is the module name inside them.

/** `$paramod$ac1d…\uart_tx` -> `uart_tx`; `$paramod\breathe\STEP_DIV=…` -> `breathe`. */
export function cleanModuleName(name) {
  if (!name) return name
  if (!name.startsWith('$paramod')) return name.replace(/^\\/, '')
  const parts = name.split('\\').filter(Boolean)
  // [$paramod, breathe, STEP_DIV=…] or [$paramod$hash, uart_tx]
  return parts[1] ?? name
}

export function topModule(netlist) {
  const mods = netlist?.modules ?? {}
  const names = Object.keys(mods)
  return names.find((n) => Number(mods[n]?.attributes?.top) === 1 || mods[n]?.attributes?.top === '00000000000000000000000000000001')
    ?? names.find((n) => !n.startsWith('$paramod')) ?? names[0] ?? null
}

/** A module's resolved parameters, readable: { STEP_DIV: '62500' }. `prep` folds an instance's
 * parameters into the module it specialises, and keeps their values there. */
export function paramsOf(mod) {
  const out = {}
  for (const [k, v] of Object.entries(mod?.parameter_default_values ?? {})) {
    out[k] = /^[01]+$/.test(v) && v.length <= 53 ? String(parseInt(v, 2)) : String(v)
  }
  return out
}

/** The instance tree: { name, module, label, path, children: [...] } from the top down. */
export function hierarchy(netlist) {
  const mods = netlist?.modules ?? {}
  const top = topModule(netlist)
  if (!top) return null
  const walk = (moduleName, instName, path, depth) => {
    const mod = mods[moduleName]
    const node = { name: instName, module: moduleName, label: cleanModuleName(moduleName), path, children: [], cells: 0 }
    if (!mod || depth > 32) return node
    node.cells = Object.keys(mod.cells ?? {}).length
    for (const [cellName, cell] of Object.entries(mod.cells ?? {})) {
      if (mods[cell.type]) {
        const child = walk(cell.type, cellName, path ? `${path}.${cellName}` : cellName, depth + 1)
        child.params = paramsOf(mods[cell.type])
        node.children.push(child)
      }
    }
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    return node
  }
  return walk(top, cleanModuleName(top), '', 0)
}

/** Every `s:alias`/`s:type` the skin knows; a cell type outside this set is drawn as a generic box. */
export function skinTypes(skinText) {
  const set = new Set()
  for (const m of skinText.matchAll(/s:(?:alias val|type)="([^"]+)"/g)) set.add(m[1])
  return set
}

/**
 * One module, alone, as netlistsvg wants it: marked top, with instances of other modules and
 * internal cell types given readable names (netlistsvg prints a generic box's type as its label).
 */
export function moduleForRender(netlist, moduleName, known = new Set()) {
  const mods = netlist?.modules ?? {}
  const mod = mods[moduleName]
  if (!mod) return null
  const cells = {}
  for (const [name, cell] of Object.entries(mod.cells ?? {})) {
    let type = cell.type
    if (mods[type]) type = `${cleanModuleName(type)} ${name}`
    else if (!known.has(type) && type.startsWith('$')) type = type.slice(1)
    cells[name] = { ...cell, type }
  }
  return {
    modules: {
      [cleanModuleName(moduleName)]: { ...mod, attributes: { ...(mod.attributes ?? {}), top: 1 }, cells },
    },
  }
}

/** What the page needs to name what the pointer is over, for one module. */
export function moduleIndex(netlist, moduleName) {
  const mods = netlist?.modules ?? {}
  const mod = mods[moduleName]
  if (!mod) return null
  const nets = {} // "7,8,9" -> { names: [...], width }
  const bitNames = {} // 7 -> ["idx[0]"]
  const entries = Object.entries(mod.netnames ?? {})
  // Named nets first, so a lookup lands on `idx` before `$0\idx[2:0]`.
  entries.sort((a, b) => (a[1].hide_name ?? 0) - (b[1].hide_name ?? 0))
  for (const [name, net] of entries) {
    const bits = net.bits ?? []
    const key = bits.join(',')
    if (!nets[key]) nets[key] = { names: [], width: bits.length, hidden: net.hide_name ? 1 : 0, src: net.attributes?.src ?? '' }
    nets[key].names.push(name)
    bits.forEach((b, i) => {
      if (typeof b !== 'number') return
      if (!bitNames[b]) bitNames[b] = []
      if (bitNames[b].length < 3) bitNames[b].push(bits.length > 1 ? `${name}[${i}]` : name)
    })
  }
  const cells = {}
  for (const [name, cell] of Object.entries(mod.cells ?? {})) {
    const sub = mods[cell.type]
    cells[name] = {
      type: sub ? cleanModuleName(cell.type) : cell.type,
      src: cell.attributes?.src ?? '',
      module: sub ? cell.type : null,
      params: sub ? paramsOf(sub) : undefined,
      hidden: name.startsWith('$') ? 1 : 0,
    }
  }
  const ports = {}
  for (const [name, port] of Object.entries(mod.ports ?? {})) {
    ports[name] = { direction: port.direction, width: (port.bits ?? []).length }
  }
  return { module: moduleName, label: cleanModuleName(moduleName), src: mod.attributes?.src ?? '', params: paramsOf(mod), nets, bitNames, cells, ports }
}
