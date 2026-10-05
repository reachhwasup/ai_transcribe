#!/bin/bash
# Start both servers (backend :8008, frontend :5173) in the background.
# Logs: backend.log and frontend.log. Run ./stop.sh to stop them.
cd "$(dirname "$0")"

if ! lsof -ti :8008 -sTCP:LISTEN >/dev/null 2>&1; then
    # The two timeouts matter: without them a --reload restart waits forever for open
    # connections (media streams, SSE) to close, and the backend never comes back up.
    # The venv is excluded from --reload: installing a package used to restart the server and
    # kill whatever was running — a long vocal/BGM separation was lost that way. uvicorn only
    # honours the exclude as an absolute path.
    nohup backend/venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8008 --reload \
        --reload-exclude "$(pwd)/backend/venv" \
        --timeout-graceful-shutdown 1 --timeout-keep-alive 5 > backend.log 2>&1 &
    echo "backend starting on http://localhost:8008 (log: backend.log)"
else
    echo "backend already running on :8008"
fi

if ! lsof -ti :5173 -sTCP:LISTEN >/dev/null 2>&1; then
    (cd frontend && nohup npm run dev > ../frontend.log 2>&1 &)
    echo "frontend starting on http://localhost:5173 (log: frontend.log)"
else
    echo "frontend already running on :5173"
fi

sleep 5
curl -s --max-time 5 http://localhost:8008/api/health >/dev/null && echo "✓ backend OK" || echo "✗ backend not responding yet — check backend.log"
curl -s --max-time 5 -o /dev/null http://localhost:5173/ && echo "✓ frontend OK" || echo "✗ frontend not responding yet — check frontend.log"
echo "Open http://localhost:5173"
