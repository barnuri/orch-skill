FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile || bun install
COPY . .
ENV HARNESS_ORCH_HOME=/orch-home ORCH_HERDR=0
EXPOSE 6724
CMD ["bun", "skills/orch/scripts/dispatch.ts", "serve", "--host", "0.0.0.0", "--port", "6724"]
