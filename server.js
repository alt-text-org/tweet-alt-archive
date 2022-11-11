const path = require('path')
const crypto = require("crypto");

const fastify = require('fastify')({logger: false});
const {auth} = require("twitter-api-sdk");
const {v4} = require("uuid")
const fs = require("fs");
const child_process = require("child_process");

fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'public'),
    prefix: '/public/'
});

const config = {
    twitter: {
        client_id: process.env.TWITTER_CLIENT_ID,
        client_secret: process.env.TWITTER_CLIENT_SECRET
    }
}

const twtr = new auth.OAuth2User({
    client_id: config.twitter.client_id,
    client_secret: config.twitter.client_secret,
    callback: "https://archive.alt-text.org/callback",
    scopes: ["tweet.read", "users.read"],
});

fastify.get("/common.css", function (request, reply) {
    reply.sendFile("common.css")
})

fastify.get("/src/jszip.min.js", function (request, reply) {
    reply.sendFile("src/jszip.min.js")
})

fastify.get("/", function (request, reply) {
    reply.sendFile("index.html")
});

fastify.get("/archive", function (request, reply) {
    reply.sendFile("archive.html")
});

fastify.get("/download", function (request, reply) {
    reply.sendFile("download.html")
});

fastify.get("/search", function (request, reply) {
    reply.sendFile("search.html")
});


fastify.get("/health", function (request, reply) {
    reply.status(200).send()
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

        reply.redirect(307, `/archive?code=${code}`);
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
        if (!code) {
            reply.status(400).send({error: "Missing twitter code"})
            return
        }

        if (!tweet_ids || tweet_ids.length === 0) {
            reply.status(400).send({error: "No tweet ids specified"})
            return
        }

        const uuid = v4();

        const tokenWrapper = await twtr.requestAccessToken(code);
        let token = null;
        if (tokenWrapper && tokenWrapper.token && tokenWrapper.token.access_token) {
            token = tokenWrapper.token.access_token
        } else {
            reply.status(500).send({error: "Couldn't get token from Twitter"})
            return
        }

        let file = `./in-progress/${uuid}.json`;
        fs.writeFileSync(file, JSON.stringify({
            token,
            tweet_ids
        }));

        const child = child_process.spawn("/home/hannah/.nvm/versions/node/v16.18.1/bin/node", ["./task.js", uuid]);
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
