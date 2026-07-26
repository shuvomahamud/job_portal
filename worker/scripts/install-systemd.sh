#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash worker/scripts/install-systemd.sh" >&2
  exit 1
fi

id -u shuvo >/dev/null 2>&1 || { echo "Expected VPS user shuvo was not found." >&2; exit 1; }
mkdir -p /home/shuvo/.job-portal /home/shuvo/.job-worker-browser-profile
chown shuvo:shuvo /home/shuvo/.job-portal /home/shuvo/.job-worker-browser-profile
install -m 0644 worker/systemd/job-worker.service /etc/systemd/system/job-worker.service
systemctl daemon-reload
systemctl enable job-worker.service

echo "Installed job-worker.service. Add /home/shuvo/.job-portal/vps-worker.env, then run: sudo systemctl start job-worker"
