# Build dependencies
FROM node:10-alpine AS builder

RUN apk --no-cache add python2 git make g++

RUN mkdir /app
WORKDIR /app

COPY ./package* /app/
RUN npm install

# Generate third-party licenses file
FROM node:10-alpine AS licenses
WORKDIR /app
COPY --from=builder /app/node_modules /app/node_modules
RUN npm install license-extractor
RUN node_modules/license-extractor/bin/licext --mode output > /app/LICENSE.thirdparties.txt

# Package
FROM node:10-alpine

WORKDIR /app

COPY --from=builder /app/node_modules /app/node_modules

COPY --from=licenses /app/LICENSE.thirdparties.txt /app/LICENSE.thirdparties.txt

# Directories
COPY bin /app/bin
COPY src /app/src
COPY test /app/test

# Files
COPY index.js /app/index.js
COPY package* /app/
COPY LICENSE.txt /app/LICENSE.txt
COPY README.md /app/README.md

EXPOSE 3000
