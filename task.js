const fs = require("fs");
const {Client, auth} = require("twitter-api-sdk");
const {Storage} = require("@google-cloud/storage");
const stream = require('stream');

const args = process.argv.slice(2);
const [uuid, code, tweetFile] = args

const config = {
    gcs_token: process.env.GCS_TOKEN,
    twitter: {
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET
    }
}

if (tweetFile) {
    task(config, uuid, code, tweetFile)
        .catch(async err => {
            console.log(err)
            await error(`Task failed: ${err}`, uuid)
        });
} else {
    error("Internal error, task was not invoked correctly", uuid).catch()
}

async function task(config, uuid, code, tweetFile) {
    const twtr = await makeTwitterClient(config);
    const tweets = fs.readFileSync(tweetFile).toJSON();

    const alt = [];
    for (let i = 0; i < tweets.length; i += 100) {
        let slice = tweets.slice(i, i + 100);
        if (slice.length > 0) {
            (await getTweets(twtr, slice)).forEach(tweet => alt.push(tweet));
        }
    }

    saveToGcs(`/archive/${uuid}/result.json`, alt);
}

async function getTweets(twtr, tweetIds) {
    let sleep = 1000
    while (true) {
        let tweets = await tryGetTweets(twtr, tweetIds).catch(err => console.log(err))
        if (tweets) {
            return tweets
        }

        await new Promise(r => setTimeout(r, sleep));
        sleep = Math.min(15000, sleep + 1000)
    }
}


async function tryGetTweets(twtr, tweetIds) {
    let tweets = await twtr.tweets.findTweetsById({
        ids: tweetIds,
        expansions: ["attachments.media_keys"],
        "media.fields": ["media_key", "url", "alt_text"],
        "tweet.fields": ["entities", "lang", "attachments"]
    })

    let mediaKeyToTweetId = {}
    tweets.data.forEach(tweet => {
        if (tweet.attachments && tweet.attachments.media_keys) {
            tweet.attachments.media_keys.forEach(key => mediaKeyToTweetId[key] = tweet.id)
        }
    })

    const imagesAndAlts = [];
    if (tweets.includes && tweets.includes.media) {
        tweets.includes.media.forEach((media) => {
            if ((media.type === "photo" || media.type === "animated_gif") && media.alt_text) {
                imagesAndAlts.push({
                    tweet_id: mediaKeyToTweetId[media.media_key],
                    media_key: media.media_key,
                    media_url: media.url,
                    alt_text: media.alt_text,
                });
            }
        });
    }

    return imagesAndAlts;
}

function saveToGcs(path, contents) {
    if (typeof contents !== "object") {
        contents = JSON.stringify(contents);
    }

    const gcs = new Storage({
        projectId: "alt-text-org",
        keyFilename: config.gcs_token
    });

    const bucket = gcs.bucket("download.alt-text.org");
    const file = bucket.file(path);

    const bufferStream = new stream.PassThrough();
    bufferStream.end(Buffer.from(contents));
    bufferStream.pipe(file.createWriteStream({
        metadata: {
            contentType: 'application/json',
        },
        public: true,
        validation: "md5"
    })).on('error', function (err) {
        console.log(err)
    }).on('finish', function () {
        file.makePublic()
    });
}

async function makeTwitterClient(config, code) {
    const myClient = new auth.OAuth2User({
        client_id: config.twitter.client_id,
        client_secret: config.twitter.client_secret,
        callback: "https://archive.alt-text.org/callback",
        scopes: ["tweet.read", "users.read", "offline.access"],
    });

    const tokenWrapper = await myClient.requestAccessToken(code);
    if (tokenWrapper && tokenWrapper.token && tokenWrapper.token.access_token) {
        return new Client(new auth.OAuth2Bearer(tokenWrapper.token.access_token))
    } else {
        throw new Error("Couldn't get Twitter client")
    }
}

async function error(msg, uuid) {
    saveToGcs(`/archive/${uuid}/error.json`, msg)
}