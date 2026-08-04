FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=
RUN curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path ${OPENCODE_VERSION:+--version ${OPENCODE_VERSION}} \
 && mv /root/.opencode/bin/opencode /usr/local/bin/opencode \
 && chmod 755 /usr/local/bin/opencode \
 && rm -rf /root/.opencode

RUN useradd --create-home --shell /bin/false opencode
USER opencode
WORKDIR /home/opencode

EXPOSE 4096

ENV OPENCODE_SERVER_HOSTNAME=0.0.0.0 \
    OPENCODE_SERVER_PORT=4096

# OPENCODE_SERVER_PASSWORD is intentionally not baked into the image.
# Pass it at runtime via `docker run -e` or docker-compose `env_file:` so the
# same image can be redeployed without rebuilding when the password rotates.

ENTRYPOINT ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
