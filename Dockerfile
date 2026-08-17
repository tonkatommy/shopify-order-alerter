FROM node:22-alpine

# tzdata is not in the slim alpine base, and node-cron needs the IANA database
# to resolve Pacific/Auckland — without it the digest silently runs in UTC.
RUN apk add --no-cache tzdata

WORKDIR /app

# Copy manifests first so `npm ci` is cached independently of source changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# State lives on a mounted volume; create the mount point with the right owner
# before dropping to the unprivileged node user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production
ENV STATE_FILE_PATH=/data/state.json

CMD ["node", "src/index.js"]
