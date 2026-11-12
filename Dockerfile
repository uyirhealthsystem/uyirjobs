# Uyir nurse registration: production image (ECS Fargate).
#   Build:  docker build -t uyir .
# Stage 1 builds the React app; stage 2 installs the API's production dependencies;
# the final image holds only the API, its node_modules and the built static files.

FROM node:24-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:24-slim AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/tmp/uyir-data \
    WEB_DIST=/app/public
WORKDIR /app

# Amazon RDS certificate bundle, so the database connection is verified TLS (DATABASE_CA_FILE).
# (Not ADD --chmod: it also applies 644 to the created /app/certs folder, which the node user then can't enter.)
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
RUN chmod 755 /app/certs && chmod 644 /app/certs/rds-global-bundle.pem

COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY server/scripts ./scripts
COPY --from=web /web/dist ./public

# Run as the unprivileged "node" user.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
