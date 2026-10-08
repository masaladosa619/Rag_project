#!/usr/bin/env bash
# Auto-resume the vector DB rebuild until it completes.
# Each rebuild_db.py run survives ~17 min of quota exhaustion on its own;
# this wrapper sleeps 30 min and retries (max 12 attempts ≈ 6 h).
cd "$(dirname "$0")"

for i in $(seq 1 12); do
  echo "=== rebuild attempt $i: $(date) ===" >> rebuild.log
  if /home/masaladosa/Rag_project/venv/bin/python rebuild_db.py >> rebuild.log 2>&1; then
    echo "=== rebuild complete: $(date) ===" >> rebuild.log
    exit 0
  fi
  echo "=== attempt $i failed, retrying in 30 min ===" >> rebuild.log
  sleep 1800
done

echo "=== rebuild gave up after 12 attempts ===" >> rebuild.log
exit 1
