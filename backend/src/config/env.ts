import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // The single web-facing port: control API + data-plane reverse proxy.
  PORT: z.string().default('8085').transform(Number),

  // Dedicated PUBLIC subdomain app-proxy port. Traffic to [sub].<APP_DOMAIN_SUFFIX> hits this
  // listener (Host-header routed), separate from the api-key control/`/proxy` plane on PORT.
  PORT_APP_PROXY: z.string().default('8087').transform(Number),
  // Domain suffix stripped from the Host header to get the subdomain (e.g. ".harness.autonomous.ai").
  APP_DOMAIN_SUFFIX: z.string().default('.harness.autonomous.ai'),

  // Same MongoDB (and database) as the agent-manager — backend owns `users` +
  // `machines`; reads `managers`/`machine_nodes` via raw queries when needed.
  DATABASE_URL: z.string().default('mongodb://localhost:27017/harness?replicaSet=rs0'),

  // Redis for the cross-instance data bus. Behind a load balancer an agent's web socket and its
  // manager socket may land on different backend instances; Redis pub/sub bridges them
  // (channels up:{machineId} / down:{machineId}) plus an agent→manager presence key. See lib/bus.ts.
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // This backend instance's stable id (used to route manager-command replies via Redis in a
  // multi-instance deploy). Defaults to the pm2 instance index or a per-process fallback.
  BACKEND_INSTANCE_ID: z.string().default(''),

  // Instance mesh (Phase 2 of the data-plane short-circuit): each backend instance/worker binds an
  // INTERNAL-only listener and advertises its endpoint in Redis (inst:{id}:mesh). A public app-request
  // that lands on an instance NOT holding the agent's manager socket is forwarded to the instance that
  // does (agent:{machineId}:appinst), so the data path is a direct backpressured socket, not Redis relay.
  // Off by default (single-instance/dev needs nothing — it's always co-located). Enable in multi-instance.
  MESH_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  // Host the mesh endpoint is reachable at from OTHER instances: 127.0.0.1 for a single-host pm2 cluster,
  // the VM's routable IP for multi-VM. Advertised verbatim in Redis.
  MESH_HOST: z.string().default('127.0.0.1'),
  // Base internal port; each worker binds MESH_PORT_BASE + NODE_APP_INSTANCE (distinct per worker).
  MESH_PORT_BASE: z.string().default('8095').transform(Number),

  // Remote-terminal WebRTC is STUN-only: successful ICE bypasses the backend data relay; failed ICE
  // keeps using the existing WebSocket route. Enabled by default; percentage 0 is the kill switch.
  TERMINAL_P2P_ROLLOUT_PERCENT: z.coerce.number().int().min(0).max(100).default(100),
  // Comma-separated, capped at ten (was eight until 2026-09-10 — the CLI's own parsing of this list on
  // the OFFERER side, remoteRelay.ts's p2pPolicy(), was separately capping at 4, so half of whatever
  // shipped here was silently dropped before an offer was ever built; raised there to 10 to match).
  // werift itself has no failover — parseIceServers() collapses the list to a single `stunServer`
  // (first stun: url wins) — so the CLI races these with its own STUN binding requests and hands
  // werift the fastest responder (cli/src/lib/stunSelect.ts). Older CLIs simply use the first entry,
  // exactly as before, so a longer list is safe to ship at any time.
  // Port 53 is here because networks that drop unusual UDP ports usually still pass DNS; the race
  // drops it at runtime if it ever stops answering, so listing it costs nothing.
  // Beyond Cloudflare: two Google mirrors, Twilio, Nextcloud (also firewall-friendly :443), Ekiga and
  // VoIPGate — all live-probed with a real RFC 5389 binding request before being added (2026-09-09);
  // stun.stunprotocol.org and stun.services.mozilla.com were dropped for the same reason (no DNS record
  // any more). Added 2026-09-10, also live-probed: Linphone's official server (Belledonne
  // Communications — has its own documented DNS-SRV failover to sip1.linphone.org, unlike the
  // similarly-themed stun.freeswitch.org and stun.antisip.com candidates considered and rejected —
  // the former has open GitHub issues reporting real instability, the latter has no confirmed owner at
  // all) and Xiaomi's MiWiFi server, which is real production infra for millions of routers and — more
  // to the point — the one entry here actually reachable from behind networks that block the Western
  // majority of this list, filling a gap none of the other eight cover.
  TERMINAL_P2P_STUN_URLS: z.string().default(
    'stun:stun.cloudflare.com:3478,stun:stun.cloudflare.com:53,'
    + 'stun:stun.l.google.com:19302,stun:stun2.l.google.com:19302,'
    + 'stun:global.stun.twilio.com:3478,stun:stun.nextcloud.com:443,'
    + 'stun:stun.ekiga.net:3478,stun:stun.voipgate.com:3478,'
    + 'stun:stun.linphone.org:3478,stun:stun.miwifi.com:3478',
  ),
  // 2500, not 1500: a TURN-relayed data channel was measured opening in 1372ms, and this is the gate
  // (remoteRelay.ts) that decides whether the FIRST terminal takes p2p or falls back to the WS relay.
  // At 1500 the relay path loses that race almost every time and only the second terminal gets p2p.
  TERMINAL_P2P_OPEN_WAIT_MS: z.coerce.number().int().min(0).max(5000).default(2500),

  // Cloudflare Realtime TURN. Optional on purpose: with no key the policy ships STUN-only, which is
  // exactly the pre-TURN behaviour, so clearing TERMINAL_P2P_TURN_KEY_ID is the kill switch. Checked
  // at the consumer (lib/turnCredentials.ts), not here — same as GEMINI_API_KEY/DEEPGRAM_API_KEY.
  TERMINAL_P2P_TURN_KEY_ID: z.string().optional(),
  TERMINAL_P2P_TURN_API_TOKEN: z.string().optional(),
  // Cloudflare caps credential ttl at 172800 (48h); we refresh well before expiry anyway.
  TERMINAL_P2P_TURN_TTL_SECONDS: z.coerce.number().int().min(600).max(172800).default(7200),
  TERMINAL_P2P_TURN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(5000),

  // No manager env: each manager publishes its apiKey + capacity into the `managers` collection;
  // the backend authenticates the manager's dial-in socket (/api/manager-ws) against that apiKey and
  // picks a manager on create by capacity (machines.managerId → managers). See lib/managers.ts.

  // Autonomous SSO (OAuth2 Authorization Code + PKCE). The backend exchanges the code, then hands
  // the SSO access token to the web. Control-plane REST + web WS validate that token through the
  // Autonomous profile API instead of minting a second backend-owned session JWT.
  SSO_ISSUER: z.string().default('https://auth.autonomous.ai'),
  SSO_CLIENT_ID: z.string().default('command_57db108dd2391a9a4bedd6d079bdbe3e'),
  SSO_CLIENT_SECRET: z.string().optional(), // public client (PKCE, auth method 'none') → leave unset
  SSO_SCOPE: z.string().default('openid profile email roles'),
  SSO_PROFILE_URL: z.string().default('https://apiv2.autonomous.ai/api/v1/me/profile'),
  // Per-user staging override. Production remains the default; these are consulted only after the
  // login transaction/user record explicitly selects `stag`.
  STAGING_SSO_ISSUER: z.string().default('https://auth.staging.autonomousdev.xyz'),
  STAGING_SSO_CLIENT_ID: z.string().optional(),
  STAGING_SSO_CLIENT_SECRET: z.string().optional(),
  STAGING_SSO_PROFILE_URL: z.string().default('https://apiv2.staging.autonomousdev.xyz/api/v1/me/profile'),
  SSO_PROFILE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Forces the SSO account picker so users can switch accounts (not silently auto-login the last one).
  // Set to '' to disable, or 'login' to force re-entering credentials.
  SSO_PROMPT: z.string().default('select_account'),
  // Backend callback registered with the SSO client. LEAVE EMPTY to auto-derive from the request host
  // (so live→live, local→local); set explicitly only to pin one value. Must be a value registered
  // with the client on the Autonomous side.
  SSO_REDIRECT_URI: z.string().default(''),
  // The primary/fallback SPA origin the browser is sent back to after login (also the first allowed
  // origin). Live sets this to https://harness.autonomous.ai.
  WEB_URL: z.string().default('http://localhost:3000'),
  // Extra allowed SPA origins (comma-separated), e.g. to let one backend serve both live + local.
  // The post-login token is only ever redirected to an origin in this allowlist (never an arbitrary
  // one from the request), so it can't be leaked to a spoofed host.
  WEB_ORIGINS: z.string().default(''),

  // Autonomous campaign billing for NEW managed machines. A cold catalog outage still cannot expose
  // incomplete plans: the seeder retains a complete cache or falls back to Remote only.
  HARNESS_BILLING_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  // Ceiling on billing-free Remote machines auto-created by the device-auth grant
  // (`harness auth device`). That path is free and its computer id is self-declared, so this caps the
  // rows one account can mint; 0 disables the check. Hygiene, not a security control.
  HARNESS_DEVICE_AUTH_MACHINE_LIMIT: z.coerce.number().int().min(0).default(20),
  AUTONOMOUS_BFF_URL: z.string().url().default('https://apiv2.autonomous.ai'),
  STAGING_AUTONOMOUS_BFF_URL: z.string().url().default('https://apiv2.staging.autonomousdev.xyz'),
  // Server-to-server subscription snapshots used by the singleton billing worker. These use
  // environment-specific x-api-key credentials, never a user's SSO access token.
  AUTONOMOUS_CAMPAIGN_API_URL: z.string().url().default('https://campaign-api.autonomous.ai'),
  STAGING_AUTONOMOUS_CAMPAIGN_API_URL: z.string().url().default('https://campaign-api.staging.autonomousdev.xyz'),
  AUTONOMOUS_CAMPAIGN_API_KEY: z.string().optional(),
  STAGING_AUTONOMOUS_CAMPAIGN_API_KEY: z.string().optional(),
  // Origins accepted by Autonomous' hosted-checkout endpoint. They belong to the selected
  // Autonomous environment, not to the Machine UI that supplied success_url/failure_url.
  AUTONOMOUS_CHECKOUT_ORIGIN: z.string().url().default('https://autonomous.ai'),
  STAGING_AUTONOMOUS_CHECKOUT_ORIGIN: z.string().url().default('https://staging.autonomousdev.xyz'),
  AUTONOMOUS_BFF_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // NB: the VALUE is an identifier registered on the EXTERNAL campaign API — subscriptions are matched
  // by campaignCode, so this must stay in lockstep with the campaign registered there. Renamed to
  // `ai-harness-device` with the Machine rebrand: the campaign has to be renamed on the campaign side
  // too, otherwise existing subscriptions stop matching and machines read as unpaid.
  HARNESS_CAMPAIGN_CODE: z.string().default('ai-harness-device'),
  HARNESS_DEVICE_TYPE: z.coerce.number().int().positive().default(15),
  HARNESS_DEVICE_TIMEZONE_DEFAULT: z.string().default('Asia/Saigon'),
  // DEV ONLY. A `provider` machine dials a URL its owner typed, so plain http:// and loopback are
  // refused (see lib/providerUrl.ts). This flag lifts the scheme check so a developer can point a
  // machine at a local example-provider (autonomous-ai/autonomous-harness). Setting it in production
  // disables an SSRF control — boot
  // logs a FATAL-level warning if it is on there.
  PROVIDER_ALLOW_INSECURE_URLS: z.coerce.boolean().default(false),
  // Callback page on the web app. When empty, WEB_URL/machine-checkout is used.
  HARNESS_CHECKOUT_CALLBACK_URL: z.string().default(''),
  // Shared with agent-manager. 32 raw bytes encoded as base64; required when billing is enabled.
  HARNESS_CREDENTIAL_ENCRYPTION_KEY: z.string().default(''),

  // Comma-separated emails granted role=admin on first creation.
  ADMIN_EMAILS: z.string().default(''),

  // Device voice STT (PCM arrives on /api/device-ws → batch STT). VOICE_PROVIDER selects the backend:
  //   'deepgram' → needs DEEPGRAM_API_KEY
  //   'gemini'   → needs GEMINI_API_KEY (model via GEMINI_STT_MODEL)
  VOICE_PROVIDER: z.enum(['deepgram', 'gemini']).default('deepgram'),
  DEEPGRAM_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_STT_MODEL: z.string().default('gemini-2.0-flash'),

  // Shared secret for POST /api/cursor/stt — the standalone file-upload STT endpoint the Cursor desktop
  // app calls (routes/cursor.ts). That client is neither a device nor a browser session, so it holds
  // no machine api key and no SSO token; this is its only credential, sent as the `api_key` header.
  // Optional here, but the route fails CLOSED when unset: an absent secret must never read as "open" on
  // an endpoint that spends Deepgram credit.
  CURSOR_STT_API_KEY: z.string().optional(),

  // The LLM behind POST /api/cursor/summarize — an OpenAI-compatible endpoint (the Grid relay). The base
  // URL already ends in `/v1` and embeds a network id, and the key is a long-lived JWT, so neither is
  // hardcoded; routes/cursor.ts appends `/chat/completions`. URL and key are optional here but the route
  // fails CLOSED without them, for the same reason CURSOR_STT_API_KEY does: this endpoint spends credit.
  CURSOR_LLM_BASE_URL: z.string().optional(),
  CURSOR_LLM_API_KEY: z.string().optional(),
  CURSOR_LLM_MODEL: z.string().default('DeepSeek-V4-Flash-0731'),

  // TTL for the in-memory subdomain→machineId cache on the public app-proxy hot path
  // (avoids a Mongo lookup per request). Bounds staleness after a cross-instance app teardown.
  // 60 min default (mapping is stable; a same-instance delete evicts immediately).
  AGENT_TARGET_CACHE_TTL_MS: z.string().default('3600000').transform(Number),
  // TTL for NEGATIVE caching of unknown subdomains — so scans/misconfigured DNS hitting nonexistent
  // subdomains don't hit Mongo on every request. Short so a subdomain registered on another instance
  // becomes reachable quickly. 5s default.
  AGENT_TARGET_NEG_CACHE_TTL_MS: z.string().default('5000').transform(Number),

  // Public app-proxy safety limits. 0 disables the byte limit for that direction. These protect the
  // unauthenticated subdomain data-plane from unbounded tunnel/socket buffering.
  APP_PROXY_MAX_REQUEST_BYTES: z.string().default('104857600').transform(Number), // 100 MiB
  APP_PROXY_MAX_RESPONSE_BYTES: z.string().default('536870912').transform(Number), // 512 MiB
  APP_PROXY_MAX_WS_FRAME_BYTES: z.string().default('8388608').transform(Number), // 8 MiB
  APP_PROXY_MAX_STREAMS_PER_SUBDOMAIN: z.string().default('128').transform(Number),
  APP_PROXY_IDLE_TIMEOUT_MS: z.string().default('300000').transform(Number), // 5 min

})

export type Env = z.infer<typeof envSchema>

function validateEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors)
    process.exit(1)
  }
  const data = parsed.data
  if (data.HARNESS_BILLING_ENABLED) {
    let key: Buffer
    try { key = Buffer.from(data.HARNESS_CREDENTIAL_ENCRYPTION_KEY, 'base64') } catch { key = Buffer.alloc(0) }
    if (key.length !== 32) {
      console.error('Invalid environment variables: HARNESS_CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as base64 when HARNESS_BILLING_ENABLED=true')
      process.exit(1)
    }
  }
  return data
}

export const env = validateEnv()

/** Lower-cased set of admin emails (empty entries dropped). */
export const ADMIN_EMAILS = new Set(
  env.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
)
