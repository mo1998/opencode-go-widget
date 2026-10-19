# Zero-dependency runtime — no npm install needed.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    WIDGET_HOST=0.0.0.0 \
    WIDGET_PORT=8787

COPY package.json ./
COPY lib ./lib
COPY public ./public
COPY server.js cli.js ./

# Run unprivileged.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
