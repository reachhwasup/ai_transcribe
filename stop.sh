#!/bin/bash
# Stop both dev servers.
lsof -ti :8000 | xargs kill -9 2>/dev/null && echo "backend stopped" || echo "backend was not running"
lsof -ti :5173 | xargs kill -9 2>/dev/null && echo "frontend stopped" || echo "frontend was not running"
