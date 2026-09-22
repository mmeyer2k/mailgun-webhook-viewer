FROM node:22

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

# Drop to the unprivileged user the node image already ships (uid 1000). This
# container is the internet-facing half of the deployment — POST /webhook is
# reachable from outside — so a bug there should not start life as root with
# the Mailgun signing key in reach.
#
# Everything under WORKDIR is installed as root above and only needs to be
# readable afterwards, which it is. The bind-mounted source (./server,
# ./public) is likewise read-only in practice. Secrets do NOT arrive as a
# bind-mounted file: compose reads .env on the host and injects the values as
# environment, so the file stays 0600 root-owned and this user never needs to
# read it.
USER node

EXPOSE 3000

CMD ["npm", "start"]
