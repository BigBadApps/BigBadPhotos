# ── Stage 1: Build the React/Vite frontend ───────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# Install Node dependencies
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

# Copy frontend source and build
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Python runtime with built frontend ───────────────────────────────
FROM python:3.11-slim

# Install system dependencies required by opencv-python-headless
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY app.py ./
COPY backend/__init__.py backend/google_drive.py ./backend/

# Copy the built frontend from Stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

EXPOSE 8080

# Railway injects PORT at runtime; app.py already reads it
ENV PORT=8080

CMD ["python", "app.py"]
