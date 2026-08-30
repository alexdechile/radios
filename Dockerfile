FROM python:3.10-slim

# Install system dependencies needed for building python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libxml2-dev \
    libxslt-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application files
COPY . .

# Expose default Hugging Face Spaces port
EXPOSE 7860

# Run the server
CMD ["python", "server.py", "--port", "7860"]
