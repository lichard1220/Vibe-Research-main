FROM python:3.12-slim

WORKDIR /app

# akshare / lxml / curl-cffi 等依赖需要编译环境
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ \
    libxml2-dev libxslt1-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8900

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8900"]
