#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash worker/scripts/install-systemd.sh" >&2
  exit 1
fi

id -u jobworker >/dev/null 2>&1 || useradd --system --home /opt/job-worker --shell /usr/sbin/nologin jobworker
mkdir -p /opt/job-worker
chown -R jobworker:jobworker /opt/job-worker
install -m 0644 worker/systemd/job-worker.service /etc/systemd/system/job-worker.service
systemctl daemon-reload
systemctl enable job-worker.service

echo "Installed job-worker.service. Add /opt/job-worker/.env, then run: sudo systemctl start job-worker"
