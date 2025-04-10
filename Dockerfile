FROM node:22-slim AS base

# Set up pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Install necessary dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git \
        cmake \
        clang \
        libgomp1 \
        openssl \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/app

# Copy package files
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/

# Install dependencies first for better caching
RUN pnpm install --frozen-lockfile

# Generate Prisma client explicitly
RUN node node_modules/prisma/build/index.js generate

# Copy the rest of the application code
COPY . .

# Build the application
RUN pnpm run build

# Production stage
FROM node:22-slim AS runner

# Set up pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Install runtime dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        openssl \
        ca-certificates \
        libgomp1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/app

# Copy necessary files
COPY --from=base /usr/app/node_modules ./node_modules
COPY --from=base /usr/app/dist ./dist
COPY --from=base /usr/app/package.json ./package.json
COPY --from=base /usr/app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=base /usr/app/prisma ./prisma

# Generate Prisma client in the runner stage
RUN node node_modules/prisma/build/index.js generate

CMD [ "pnpm", "start:prod" ]
