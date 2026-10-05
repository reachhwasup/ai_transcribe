#!/bin/bash
# Stop both dev servers.
lsof -ti :8008 | xargs kill -9 2>/dev/null && echo "backend stopped" || echo "backend was not running"
# A backend stuck mid-reload has already given up port 8008, so catch it by name too
pkill -9 -f "uvicorn backend.main:app" 2>/dev/null && echo "cleared a stuck backend process" || true
lsof -ti :5173 | xargs kill -9 2>/dev/null && echo "frontend stopped" || echo "frontend was not running"
