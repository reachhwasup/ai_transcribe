#!/bin/bash
# ====================================================================
# VoxCPM2 Web Studio Launcher
# Starts the Gradio voice cloning web app on http://localhost:7860
# ====================================================================

cd "$(dirname "$0")"

echo "======================================================="
echo "  🎙️ Starting VoxCPM2 Voice Cloning Web Studio..."
echo "======================================================="

# Activate virtualenv
if [ -d "backend/venv" ]; then
    source backend/venv/bin/activate
elif [ -d "venv" ]; then
    source venv/bin/activate
fi

# Fix SSL certificates on macOS for HuggingFace downloads
CERT_PATH="$(python3 -c 'import certifi; print(certifi.where())' 2>/dev/null)"
if [ -n "$CERT_PATH" ]; then
    export SSL_CERT_FILE="$CERT_PATH"
    export REQUESTS_CA_BUNDLE="$CERT_PATH"
fi

# Enable Apple Silicon Metal acceleration
export VOXCPM_MPS_DTYPE=float16

python3 voxcpm_studio.py "$@"
