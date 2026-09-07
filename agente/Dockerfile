FROM python:3.11-slim

# tzdata + TZ: sin los datos de zonas horarias, la variable TZ se ignora en
# SILENCIO y el proceso se queda en UTC. Eso importa aqui: brain.py le dice a
# Claudia que hora es para que interprete "manana" o "el proximo lunes", y con
# 6 horas de desfase a partir de las 6 PM de Mexico creeria que ya es otro dia.
# El valor se puede sobrescribir por variable de entorno en Railway.
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*
ENV TZ=America/Mexico_City

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
# Railway inyecta $PORT dinamico y hace health check contra el. Se usa la
# forma shell (no la de lista) para que la variable se expanda; 8000 queda
# como respaldo para correr local con docker compose.
CMD uvicorn agent.main:app --host 0.0.0.0 --port ${PORT:-8000}
