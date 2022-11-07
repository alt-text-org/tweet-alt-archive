const path = require('path')
const crypto = require("crypto");

const fastify = require('fastify')({logger: true});
const {auth} = require("twitter-api-sdk");
const {v4} = require("uuid")
const fs = require("fs");
const child_process = require("child_process");

fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'public'),
    prefix: '/public/',
})

const config = {
    twitter: {
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET
    }
}
const twtr = new auth.OAuth2User({
    client_id: config.twitter.client_id,
    client_secret: config.twitter.client_secret,
    callback: "https://archive.alt-text.org/callback",
    scopes: ["tweet.read", "users.read", "offline.access"],
});

fastify.get("/", function (request, reply) {
    reply.sendFile("index.html")
});

fastify.get("/archive", function (request, reply) {
    reply.sendFile("archive.html")
});

fastify.get("/download", function (request, reply) {
    reply.sendFile("download.html")
});

const twitterStates = {};
const MAX_STATE_LIFETIME_MILLIS = 5 * 60 * 1000;

function cleanTwitterStates() {
    for (let state in twitterStates) {
        let ts = twitterStates[state];
        if (Date.now() - ts > MAX_STATE_LIFETIME_MILLIS * 3) {
            console.log(`${ts}: Deleting expired state`);
            delete twitterStates[state];
        }
    }
}

const signupOpts = {
    handler: (request, reply) => {
        const state = crypto.randomBytes(16).toString("base64");
        twitterStates[state] = Date.now();

        const authUrl = twtr.generateAuthURL({
            state: state, code_challenge_method: "plain", code_challenge: crypto.randomBytes(64).toString("base64"),
        });

        reply.redirect(authUrl)
    },
};
fastify.get("/auth", signupOpts);

const signupCallbackOpts = {
    schema: {
        querystring: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                },
            },
        },
    },
    handler: async (request, reply) => {
        const {code, state} = request.query;

        const stateIssueTime = twitterStates[state];
        if (!stateIssueTime) {
            reply.status(400).send({error: "Unknown state"});
        } else if (Date.now() - stateIssueTime > MAX_STATE_LIFETIME_MILLIS) {
            reply.status(400).send({
                error: `State expired, must hit callback within ${MAX_STATE_LIFETIME_MILLIS} milliseconds`,
            });
        }

        delete twitterStates[state];

        reply.redirect(307, `/archive?code-${code}`);
    }
};
fastify.get("/callback", signupCallbackOpts);


const uploadOpts = {
    schema: {
        body: {
            type: "object",
            required: ["tweet_ids", "code"],
            properties: {
                tweet_ids: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                code: {
                    type: "string"
                }
            },
        },
    },
    handler: async (request, reply) => {
        const {tweet_ids, code} = request.body;
        const uuid = v4();

        let file = `/in-progress/${uuid}.json`;
        fs.writeFileSync(file, tweet_ids);
        const child = child_process.spawn(`node task.js ${uuid} ${code} ${file}`);
        child.stdout.on("data", data => {
            console.log(`${uuid}: ${data}`);
        });

        child.stderr.on("data", data => {
            console.log(`${uuid}: ${data}`);
        });

        child.on('error', (error) => {
            console.log(`spawn error: ${error.message}`);
        });

        child.on("close", code => {
            console.log(`child process ${uuid} exited with code ${code}`);
        });

        reply.status(200).send({uuid});
    }
};
fastify.post("/api/upload", uploadOpts);

setInterval(cleanTwitterStates, 10000)

// Run the server and report out to the logs
fastify.listen(
    {port: process.env.PORT, host: "0.0.0.0"},
    function (err, address) {
        if (err) {
            fastify.log.error(err);
            process.exit(1);
        }
        console.log(`Your app is listening on ${address}`);
        fastify.log.info(`server listening on ${address}`);
    }
);
