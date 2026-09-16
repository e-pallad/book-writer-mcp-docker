FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first so they stay cached across source changes
COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app

# Production-only deps: esbuild/typescript/ts-node never end up in the final image
COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Default location for the book project; mount a volume here to keep the data
ENV BOOK_PROJECT_DIR=/app/data
ENV PORT=3456
EXPOSE 3456

RUN mkdir -p /app/data && chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "dist/http-server.js"]
