#!/usr/bin/env bash
# Local dev launcher: loads .env and starts the Flask app.
set -euo pipefail
cd "$(dirname "$0")"

export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
pg_isready -q || brew services start postgresql@16

set -a
source .env
set +a

exec .venv/bin/python server/app.py
