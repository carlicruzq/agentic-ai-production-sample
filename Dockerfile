# The image is here to prove one claim: this runs the same way on your machine
# and on a build server, with nothing installed but Node.
#
#   docker build -t agentic-sample .
#   docker run --rm agentic-sample            # runs the test suite
#   docker run --rm agentic-sample npm run demo
#
# No network at runtime, no credentials, no state: the tests and the demo use a
# scripted model. `--network none` below is not decoration — it is the assertion
# that nothing in the default path calls an API.
FROM node:22-alpine

# A non-root user, because a container that runs as root by default is one
# mounted volume away from being a problem.
WORKDIR /app
COPY package.json ./
# There are no dependencies to install; the line stays so that adding one later
# does not silently skip the install step.
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY test ./test
COPY examples ./examples
USER node

ENV NODE_ENV=production
CMD ["npm", "test"]
