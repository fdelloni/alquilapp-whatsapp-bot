FROM node:20-alpine

WORKDIR /app

# Copiar dependencias primero (para cache de Docker)
COPY package*.json ./

# Instalar dependencias de produccion
RUN npm install --only=production

# Copiar el resto del codigo
COPY index.js ./

# Puerto
EXPOSE 3000

# Comando de inicio
CMD ["node", "index.js"]
