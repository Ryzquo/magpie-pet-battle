FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server.mjs ./
COPY --chown=node:node lib/combat.mjs lib/rooms.mjs lib/http.mjs lib/hub.mjs ./lib/
ENV ARENA_HOST=0.0.0.0
USER node
EXPOSE 3574
CMD ["node", "server.mjs"]
