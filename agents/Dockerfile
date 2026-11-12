# Build from the project root:  docker build -f agents/Dockerfile .
FROM python:3.12-slim
WORKDIR /app
COPY agents/requirements.txt ./agents/
RUN pip install --no-cache-dir -r agents/requirements.txt
COPY agents ./agents
COPY public/legacy/kb.json ./public/legacy/kb.json
WORKDIR /app/agents
EXPOSE 8000
CMD ["python", "run_all.py"]
