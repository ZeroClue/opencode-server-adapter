#!/bin/sh
set -e

# Persistence volumes + their parent dirs mount as root; hand the whole home
# to the `opc` runtime user so opencode can write auth, state, and repos
# inside the container. (The read-only authorized_keys mount is unaffected.)
chown -R 1000:1000 /home/opc 2>/dev/null || true

# Start sshd for the Paperclip host's workspace/skills/instructions sync.
# It listens on 2222 (compose publishes 2222->2222) and authenticates the
# deploy key (mounted into /home/opc/.ssh/authorized_keys). Serve runs
# separately below.
mkdir -p /run/sshd
cat > /etc/ssh/sshd_config <<'EOF'
Port 2222
ListenAddress 0.0.0.0
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
StrictModes no
EOF
/usr/sbin/sshd -E /var/log/sshd.log &

# opencode serve on 4096, as the non-root `opc` user, with a stable cwd
# (/work) that survives hot restarts so warm sessions can be resumed.
mkdir -p /work
chown 1000:1000 /work
exec su opc -s /bin/bash -c 'cd /work && exec opencode serve --hostname 0.0.0.0 --port 4096'