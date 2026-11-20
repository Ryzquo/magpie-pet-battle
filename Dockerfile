FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server.mjs ./
COPY --chown=node:node lib/adventure-rewards.mjs lib/combat.mjs lib/rooms.mjs lib/http.mjs lib/hub.mjs lib/wallet.mjs ./lib/
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
ENV ARENA_HOST=0.0.0.0 ARENA_WALLET_DB=/data/wallet.sqlite
USER node
EXPOSE 3574
CMD ["node", "server.mjs"]
