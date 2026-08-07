FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git openssh-server \
 && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=
RUN curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path ${OPENCODE_VERSION:+--version ${OPENCODE_VERSION}} \
 && mv /root/.opencode/bin/opencode /usr/local/bin/opencode \
 && chmod 755 /usr/local/bin/opencode \
 && rm -rf /root/.opencode

# The serve process runs as the non-root `opc` user (uid/gid 1000, matching
# the oracle-vm3 host user). It owns the stable workspace cwd (`/work`) that
# the Paperclip host syncs into over SSH.
RUN groupadd --gid 1000 opc \
 && useradd --create-home --uid 1000 --gid 1000 --shell /bin/bash -m opc \
 && passwd -d opc \
 && mkdir -p /work /home/opc/.ssh \
 && chown -R 1000:1000 /work /home/opc/.ssh \
 && chmod 700 /home/opc/.ssh

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

# opencode serve listens here; sshd listens here (SSH sync + diagnostics).
EXPOSE 4096 2222

ENV OPENCODE_SERVER_HOSTNAME=0.0.0.0 \
    OPENCODE_SERVER_PORT=4096 \
    OPENCODE_SERVER_USERNAME=opencode

# OPENCODE_SERVER_PASSWORD and OPENCODE_API_KEY are intentionally not baked
# into the image. Pass them at runtime via `docker run -e` or docker-compose
# `env_file:` so the same image can be redeployed without rebuilding when a
# credential rotates. OPENCODE_API_KEY authenticates opencode zen (provider
# `opencode`, model IDs like `opencode/<model>`).

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
