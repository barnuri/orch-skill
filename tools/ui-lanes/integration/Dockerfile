# The repo and its installed dependencies are bind-mounted by docker-compose.yml (a corp TLS proxy breaks installs
# inside the build, and disabling TLS verification is not allowed). Run `bun install` in the repo first.
FROM oven/bun:1
WORKDIR /app

WORKDIR /app
ENV HARNESS_ORCH_HOME=/orch-home ORCH_HERDR=0
EXPOSE 6724
CMD ["bun", "skills/orch/scripts/dispatch.ts", "serve", "--host", "0.0.0.0", "--port", "6724"]
