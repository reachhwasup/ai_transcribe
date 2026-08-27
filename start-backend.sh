#!/bin/bash
# Start the backend server
echo "Starting AI Transcript Backend..."
cd "$(dirname "$0")"

# Activate virtualenv if exists
if [ -d "backend/venv" ]; then
    source backend/venv/bin/activate
fi

# Fix SSL certificate issues on macOS (required for HuggingFace downloads)
CERT_PATH="$(python3 -c 'import certifi; print(certifi.where())' 2>/dev/null)"
if [ -n "$CERT_PATH" ]; then
    export SSL_CERT_FILE="$CERT_PATH"
    export REQUESTS_CA_BUNDLE="$CERT_PATH"
fi

# Enable Apple Silicon MPS for VoxCPM (faster inference on M-series chips)
export VOXCPM_MPS_DTYPE=float16

uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000 --timeout-graceful-shutdown 1 --timeout-keep-alive 5
