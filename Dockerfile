FROM node:latest

WORKDIR /api

COPY package.json /api/package.json
COPY package-lock.json /api/package-lock.json
COPY . /api

RUN npm install

CMD ["npm", "run", "start"]