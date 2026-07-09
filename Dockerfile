# Zero-dependency Bun app — no install step needed (only global fetch + Buffer).
FROM oven/bun:1.1-alpine

WORKDIR /app
COPY src ./src
# Static indexer name map (regenerated out-of-band by scripts/gen-indexers.ts). Committed so the image
# ships with it; the exporter treats it as optional at runtime.
COPY indexers.json ./

ENV PORT=9400
EXPOSE 9400

# Drop to the image's unprivileged user.
USER bun

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||9400)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "src/index.ts"]
