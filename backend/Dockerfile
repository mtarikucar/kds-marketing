# Modeled on the monorepo backend Dockerfile, pruned to what the marketing
# service needs (no cairo/pdf/native deps — only openssl for Prisma).
FROM node:20 AS development

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build the application for the production stage
RUN npm run build

# Compile the standalone package-catalog seed to plain JS so it can run in the
# production image (which has no ts-node / devDeps). The container command runs
# it after `prisma migrate deploy` on every boot — idempotent upsert, keeps the
# prod `packages` table in sync with prisma/seed-packages.ts (feature/limit keys).
RUN npx tsc prisma/seed-packages.ts --outDir dist-seed \
      --module commonjs --target ES2021 --esModuleInterop \
      --skipLibCheck --moduleResolution node

# Same treatment for the two env-driven bootstrap seeds. They import shared
# logic from src/, so they need --rootDir . (which nests the output under
# dist-seed/prisma/ — hence the different paths in the container command).
# Both no-op when their env vars are unset, so running them is always safe.
RUN npx tsc prisma/seed-operator-workspace.ts prisma/seed-platform-operator.ts \
      --outDir dist-seed --rootDir . \
      --module commonjs --target ES2021 --esModuleInterop \
      --skipLibCheck --moduleResolution node

EXPOSE 3000

CMD ["npm", "run", "start:dev"]

# Production stage
FROM node:20 AS production

# ffmpeg is here for ffprobe (MediaProbeService) and for ffmpeg itself
# (VideoAssemblyService).
#
# Five models in the media catalogue are priced on a property of the customer's
# own file — its duration, or its pixel count — and were withheld from sale
# because nothing could measure that file. A hand-written container parser was
# tried and withdrawn for being unsound in both directions. This is the real
# probe the withheld note asked for; without the binary the service degrades to
# refusing those generations, which is exactly where they were before.
#
# The font is not decoration: VideoAssemblyService burns each beat's on-screen
# text with drawtext, which needs a real font file, and DejaVu is the small
# one that actually covers the Turkish alphabet these captions are written
# in. Without it drawtext fails the whole render rather than dropping glyphs.
#
# From Debian's own repository rather than a downloaded static build, and with
# --no-install-recommends, which keeps the added layer to the codecs and drops
# the desktop/X11 tail the metapackage would otherwise pull in.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=development /app/dist ./dist
COPY --from=development /app/dist-seed ./dist-seed
COPY --from=development /app/prisma ./prisma
COPY --from=development /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=development /app/node_modules/@prisma/client ./node_modules/@prisma/client
# Handlebars email templates (EmailService resolves templates/ from cwd).
COPY --from=development /app/templates ./templates

RUN mkdir -p logs && chown -R node:node /app/logs

USER node

EXPOSE 3000

CMD ["node", "dist/main"]
