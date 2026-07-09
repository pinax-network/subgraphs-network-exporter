# Zero-dependency Bun app — no install step needed (only global fetch + Buffer).
FROM oven/bun:1.1-alpine

WORKDIR /app
COPY src ./src

ENV PORT=9400
EXPOSE 9400

# Drop to the image's unprivileged user.
USER bun

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||9400)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "src/index.ts"]
