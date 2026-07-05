#!/bin/bash
# Start both servers (backend :8000, frontend :5173) in the background.
# Logs: backend.log and frontend.log. Run ./stop.sh to stop them.
cd "$(dirname "$0")"

if ! lsof -ti :8000 -sTCP:LISTEN >/dev/null 2>&1; then
    nohup ./start-backend.sh > backend.log 2>&1 &
    echo "backend starting on http://localhost:8000 (log: backend.log)"
else
    echo "backend already running on :8000"
fi

if ! lsof -ti :5173 -sTCP:LISTEN >/dev/null 2>&1; then
    (cd frontend && nohup npm run dev > ../frontend.log 2>&1 &)
    echo "frontend starting on http://localhost:5173 (log: frontend.log)"
else
    echo "frontend already running on :5173"
fi

sleep 5
curl -s --max-time 5 http://localhost:8000/api/health >/dev/null && echo "✓ backend OK" || echo "✗ backend not responding yet — check backend.log"
curl -s --max-time 5 -o /dev/null http://localhost:5173/ && echo "✓ frontend OK" || echo "✗ frontend not responding yet — check frontend.log"
echo "Open http://localhost:5173"
