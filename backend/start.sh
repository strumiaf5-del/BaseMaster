#!/bin/bash
# Servidor de producción — 8 CPUs, 32GB RAM
# 6 workers uvicorn: cada uno maneja pedidos independientes sin bloquearse
# entre sí. El GIL no es problema porque numpy/scipy liberan el GIL y
# el ProcessPoolExecutor en streaming_engine maneja los chunks pesados.
# 2 CPUs reservadas para OS + event loops.

WORKERS=${WORKERS:-6}
HOST=${HOST:-0.0.0.0}
PORT=${PORT:-8000}

echo "Arrancando con $WORKERS workers en $HOST:$PORT"

exec uvicorn app:app \
    --host $HOST \
    --port $PORT \
    --workers $WORKERS \
    --loop uvloop \
    --http h11 \
    --timeout-keep-alive 30 \
    --log-level warning
