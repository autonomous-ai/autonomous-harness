import Bonjour from 'bonjour-service'
import { isIP } from 'node:net'
export interface DiscoveredDevice { id: string; name: string; host: string; port: number }
/** Reuse the OS's existing Avahi _autonomous._tcp advertisement. Discovery grants no trust. */
export function discoverDevices(durationMs = 3000): Promise<DiscoveredDevice[]> {
  return new Promise((resolve, reject) => {
    const found = new Map<string, DiscoveredDevice>()
    let done = false
    const bonjour = new Bonjour({}, (error: Error) => finish(error))
    const browser = bonjour.find({ type: 'autonomous', protocol: 'tcp' }, service => {
      const host = service.addresses?.find(a => isIP(a) === 4) ?? service.host
      if (service.fqdn && host && service.port > 0 && service.port <= 65535) found.set(service.fqdn, { id: service.fqdn, name: service.name, host, port: service.port })
    })
    const timer = setTimeout(() => finish(), durationMs)
    function finish(error?: Error) {
      if (done) return; done = true; clearTimeout(timer); browser.stop(); bonjour.destroy()
      if (error) reject(error); else resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)))
    }
  })
}
