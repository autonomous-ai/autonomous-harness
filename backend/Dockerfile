# Central product backend: a Fastify control API (auth/users/agents/devices) + a data-plane reverse
# proxy that forwards web traffic to the owning agent-manager. Stateless → clustered by pm2. Unlike
# the agent-manager it does NOT drive Docker, so no docker CLI / socket is needed.
FROM node:22-bookworm-slim

WORKDIR /app

# openssl so `prisma generate` detects the correct engine target (bookworm = openssl-3.0.x).
# Without it Prisma mis-detects openssl-1.1.x and the runtime can't load the query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Process manager: `npm run start:runtime` → `pm2-runtime start ecosystem.config.cjs` runs the
# clustered HTTP/WS server plus exactly one singleton job worker in one foreground
# (PID-1-friendly) process, forwards logs to stdout, and restarts on crash. (`start` is pm2 daemon
# mode — wrong for a container.) Global so it survives the dev prune.
RUN npm install -g pm2

# Install deps first (postinstall runs `prisma generate`, so the schema must be present).
# Dev deps are needed to build; prune them afterwards.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# Build, then drop dev dependencies for a leaner runtime image.
COPY tsconfig.json build.mjs ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

COPY ecosystem.config.cjs.docker ./ecosystem.config.cjs

ENV NODE_ENV=production
# 8085 = control API + /proxy data-plane; 8087 = public subdomain app-proxy (Host-routed).
EXPOSE 8085 8087
# pm2-runtime stays in the foreground so the container lives as long as the apps do.
CMD ["npm", "run", "start:runtime"]
