# syntax=docker/dockerfile:1.7
FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e

ENV NODE_ENV=development \
    CI=true
WORKDIR /app

COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY test ./test

CMD ["npm", "test"]
