FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=20000
COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir --retries 5 --timeout 60 -r requirements.txt
COPY . /app/source
RUN mkdir -p /app/public && if [ -f /app/source/public/index.html ]; then cp -R /app/source/public/. /app/public/; elif [ -f /app/source/index.html ]; then cp /app/source/index.html /app/public/index.html; else echo "ERROR: index.html missing from Docker build context" >&2; exit 1; fi
RUN cp /app/source/server.js /app/server.js && cp /app/source/bot_template.py /app/bot_template.py && cp /app/source/tests.js /app/tests.js && cp /app/source/render.yaml /app/render.yaml && cp /app/source/README.md /app/README.md
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node","server.js"]
