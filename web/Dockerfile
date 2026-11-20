FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/migrations ./migrations
# Broker drop folder baked into the image (filled from samples/submissions by scripts/fly-deploy.sh).
# Owned by node: the app tops it up with generated submissions when it runs low.
COPY --chown=node:node --from=build /app/inbox ./inbox
# The review agents' reports and ledger for App Tests (step 26), copied from docs/ by scripts/fly-deploy.sh
# when they're on the deploying machine (they aren't in git); otherwise empty, and the published set is shown.
COPY --from=build /app/agent-reports ./agent-reports
USER node
EXPOSE 3000
CMD ["node", "server.js"]
