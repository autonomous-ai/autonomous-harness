# autonomous-harness-backend — central product API + single-port reverse proxy

The **central, public-facing** backend for the distributed deployment. It is the **one port** the
web connects to. It:

1. **Manages users + auth** — `POST /api/auth/login {email,password}` issues a JWT. An unknown email
   is **created on the spot** (login doubles as signup). Admin-only user CRUD under `/api/users`.
2. **Provisions agent-nodes** — `POST /api/agents` generates a per-agent api-key, **picks a
   manager by capacity** (reads `maxNodes`/`nodeCount` from the shared `managers` collection;
   best-fit = the live manager with the least free room, 503 if all full), calls that manager's
   control API to create the node, and stores the `user → agentId/apiKey/managerUrl` binding.
   `DELETE /api/agents/:agentId` tears it down. The data-plane proxy then targets the binding's
   manager.
3. **Reverse-proxies the data plane** — every other `/api/*` request and the `/api/ws` WebSocket are
   authenticated by the **agent api key** (NOT the JWT): the client sends it (`x-api-key` for HTTP,
   the WS subprotocol) on a **`/proxy/...`** path, the backend derives `agentId = sha256(key)[:32]`,
   looks up the owning manager, and forwards the path verbatim to it (the manager mounts its data
   plane under `/proxy` and strips it before the node). So any client (a CLI, another app, the web
   chat page) can reach an agent with **only its api key**. The owner obtains that key from the
   control plane (#2); possessing it is the auth (128-bit preimage).

```
control:  web ──(JWT)──────────────────────▶ backend :8085 /api/auth|users|agents ──(x-api-key: MANAGER_API_KEY)──▶ manager :8090/api
data:     client ──(agent api key: x-api-key / WS subprotocol)──▶ backend :8085 /proxy/api/* ──▶ manager :8090/proxy/api/* ──▶ agent-node/api/*
```

## One port, two planes

A single `http.Server` (`server.ts` `serverFactory`) splits traffic by an explicit path prefix:

- **Data plane (reverse-proxied):** everything under **`/proxy/*`** (incl. the `/proxy/api/ws`
  upgrade) → `lib/proxy.ts`.
- **Local (Fastify control API):** everything else — `/api/health`, `/api/auth/*`, `/api/users/*`,
  `/api/agents*`. A stray `/api/*` that isn't a control route now 404s here instead of being proxied.

## Run

```bash
npm install            # runs `prisma generate`

# Needs MongoDB (shared with the agent-manager) + a running agent-manager:
#   cd ../autonomous-code/apps/mongodb && docker compose up -d
#   cd ../autonomous-code/apps/machine-manager && npm run dev
npm run dev            # tsx watch, :8085 by default
```

Copy `.env.example` → `.env` and set at least `MANAGER_API_KEY` (to match the manager) and a
`DATABASE_URL` pointing at the **same** MongoDB the manager uses. Production SSO/profile URLs are
the defaults; override `SSO_ISSUER` and `SSO_PROFILE_URL` with the staging hosts for local testing.

| dev | build | other |
|-----|-------|-------|
| `npm run dev` (tsx watch) | `npm run build` (esbuild via `build.mjs`) | `npm run typecheck`; `npm run test` (vitest) |

### CLI terminal P2P canary

Remote CLI-to-CLI terminals can use an ordered WebRTC DataChannel while authentication, encrypted
signaling, chat/RPC, and fallback remain on the existing WebSocket path. This mode is STUN-only and
does not require or use TURN. Configure `TERMINAL_P2P_ROLLOUT_PERCENT` (default `100`; set `0` as the kill switch),
`TERMINAL_P2P_STUN_URLS` (default Cloudflare STUN), and `TERMINAL_P2P_OPEN_WAIT_MS` (default `1500`).
When direct ICE fails, the terminal opens on WebSocket relay automatically.

## Deploy

`../.github/workflows/production-be-build.yaml` builds and pushes the production Docker image on
tag push. Backend releases are tagged **`vX.Y.Z_api`** — the `_api` suffix is what routes the push
to this workflow instead of the CLI's `../.github/workflows/release.yml` (which only reacts to
`vX.Y.Z_cli`), now that both live in this one repo. Cut one with:

```bash
make release-backend                      # patch bump
make release-backend ARGS=minor           # or major
make release-backend ARGS="1.4.1"         # exact version
make release-backend ARGS=--dry-run       # preview, tags/pushes nothing
```

(equivalent to `bash backend/scripts/release-be.sh`, see that script for details).

## Persistence

Prisma over the **same MongoDB** as the agent-manager (no migration files — `prisma db push` at
startup). The backend owns the `users` + `agent_bindings` collections; it never manages the
manager-owned `agent_nodes`/`managers` (read those via raw queries when status enrichment is needed).

Historical architecture notes still live in `autonomous-code/docs`.
