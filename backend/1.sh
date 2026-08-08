cd backend
source .venv/bin/activate

# Instalar uvloop si no está
pip install uvloop -q

nohup uvicorn app:app \
    --host 0.0.0.0 \
    --port 8000 \
    --workers 6 \
    --loop uvloop \
    --log-level warning > backend.log 2>&1 &
echo $! > backend.pid

echo "Backend corriendo en background, PID: $(cat backend.pid)"
cd ..
