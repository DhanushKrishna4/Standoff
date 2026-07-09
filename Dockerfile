# Standoff — one Node service that serves the static app AND the live-rooms
# WebSocket server (server.js). Zero dependencies, so there is no install/build
# step. Portable to Fly.io, Railway, Render, Cloud Run, etc.
FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production
# The host injects $PORT (server.js reads it, defaulting to 4173 for local use).
EXPOSE 4173
CMD ["node", "server.js"]
