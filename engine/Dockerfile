# Build from the repository root:  docker build -f engine/Dockerfile .
FROM node:22-slim
WORKDIR /app
COPY engine/package.json engine/package-lock.json ./engine/
RUN cd engine && npm ci --no-audit --no-fund
COPY engine ./engine
COPY packages/sdk/src ./packages/sdk/src
# The engine shares the protocol code with the SDK; let it find the engine's own dependencies.
RUN ln -s /app/engine/node_modules /app/node_modules
WORKDIR /app/engine
ENV NODE_ENV=production SPECULA_DATA_DIR=/data SPECULA_DB=/data/specula.sqlite LOG_FORMAT=json
EXPOSE 4100
CMD ["npx", "tsx", "src/main.ts"]
