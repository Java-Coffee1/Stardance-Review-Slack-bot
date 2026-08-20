# --- deps stage: compile better-sqlite3's native bindings ---
FROM node:20-slim AS deps
WORKDIR /app

# better-sqlite3 needs a C++ toolchain to build its native addon
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

# --- runtime stage: slim image, just the built app ---
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# SQLite file lives here — mount a volume on this path to persist it
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "src/server.js"]
