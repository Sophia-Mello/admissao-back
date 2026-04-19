FROM node:20-bullseye-slim
WORKDIR /app

# Install build tools for native module compilation
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y build-essential python3 make gcc g++ --no-install-recommends \
    && npm ci --production \
    && apt-get remove -y build-essential python3 make gcc g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY . ./

ENV NODE_ENV=production
ENV PORT=4001

EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:4001/health || exit 1

CMD ["node", "server.js"]
