#!/bin/bash
cd "$(dirname "$0")"
pkill -f "python3 server.py" 2>/dev/null
sleep 1
nohup python3 server.py > /dev/null 2>&1 &
echo "Servidor reiniciado en puerto 8000 (PID: $!)"
