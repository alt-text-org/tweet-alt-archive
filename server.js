import path from 'path';
// Require the fastify framework and instantiate it
import {fastify as fast} from "fastify";

import generated from "@fastify/static";

const fastify = fast({
  // Set this to true for detailed logging:
  logger: false,
});

// Setup our static files
fastify.register(generated, {
  root: path.join(__dirname, "public"),
  prefix: "/", // optional: default '/'
});

fastify.get("/", function (request, reply) {
});

// Run the server and report out to the logs
fastify.listen(
  { port: process.env.PORT, host: "0.0.0.0" },
  function (err, address) {
    if (err) {
      fastify.log.error(err);
      process.exit(1);
    }
    console.log(`Your app is listening on ${address}`);
    fastify.log.info(`server listening on ${address}`);
  }
);
