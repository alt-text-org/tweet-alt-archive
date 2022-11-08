const fs = require("fs");
const {Client, auth} = require("twitter-api-sdk");
const {Storage} = require("@google-cloud/storage");
const stream = require('stream');
const {parse} = require("uuid")

const args = process.argv.slice(2);
const [uuid] = args
console.log(`Got task with UUID: '${uuid}'`)

const config = {
    gcs_token: process.env.GCS_TOKEN,
}

if (uuid) {
    try {
        parse(uuid)
    } catch (err) {
        console.log(`Couldn't parse UUID: '${uuid}'`)
        console.log(err);
        return
    }

    let taskFile = `./in-progress/${uuid}.json`;
    let taskDef = JSON.parse(fs.readFileSync(taskFile, "utf8"))
    task(config, uuid, taskDef.token, taskDef.tweet_ids)
        .then(() => {
            fs.rmSync(taskFile)
        })
        .catch(async err => {
            console.log(err)
            await error(`Task failed: ${err}`, uuid)
            process.exit(1)
        });
} else {
    error("Internal error, task was not invoked correctly", uuid).catch()
}

async function task(config, uuid, token, tweets) {
    const twtr = await makeTwitterClient(config, token);
    await twtr.users.findMyUser().then(resp => {
        console.log(resp)
    })

    const alt = [];
    for (let i = 0; i < tweets.length; i += 100) {
        let slice = tweets.slice(i, i + 100);
        if (slice.length > 0) {
            (await getTweets(twtr, slice)).forEach(tweet => alt.push(tweet));
        }
    }

    saveToGcs(`archive/${uuid}/result.json`, alt);
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
        validation: "md5"
    })).on('error', function (err) {
        console.log(err)
    }).on('finish', function () {
        console.log(`Finished uploading file: '${path}'`)
    });
}

async function makeTwitterClient(token) {
    return new Client(new auth.OAuth2Bearer(token))
}

async function error(msg, uuid) {
    saveToGcs(`archive/${uuid}/error.json`, msg)
}