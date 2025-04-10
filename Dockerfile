FROM node:22 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
SHELL ["/bin/bash", "-c"]

RUN apt-get update && \
    apt-get install -y --no-install-recommends git cmake clang libgomp1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/app

COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/

FROM base AS build

# Install dependencies first
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Generate Prisma client after installing dependencies
RUN npx prisma generate

# Copy the rest of the application code
COPY . .

# Build the application
RUN pnpm run build

FROM node:22 AS runner
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /usr/app

COPY --from=build /usr/app/node_modules ./node_modules
COPY --from=build /usr/app/dist ./dist
COPY --from=build /usr/app/package.json ./package.json
COPY --from=build /usr/app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /usr/app/prisma ./prisma

# Generate Prisma client again in the runner stage
RUN pnpm install --prod --frozen-lockfile && npx prisma generate

CMD [ "pnpm", "start:prod" ]
