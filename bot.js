// bot.js
require("dotenv").config();
const tmi = require("tmi.js");
const axios = require("axios");
const { requestViewerDiscount } = require("./discountApi");

/**
 * 1. Env vars
 */
const BOT_USERNAME = process.env.BOT_USERNAME;
const TWITCH_OAUTH_TOKEN = process.env.TWITCH_OAUTH_TOKEN;
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || "!";
const OWNER_USERNAME = process.env.OWNER_USERNAME || "";
const BACKEND_URL = process.env.BACKEND_BASE_URL || "http://localhost:4000";

// channels from .env (static fallback)
const channels = (process.env.CHANNELS || process.env.CHANNEL_NAME || "")
  .split(",")
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);

if (!BOT_USERNAME || !TWITCH_OAUTH_TOKEN) {
  console.error(
    "[ERROR] Missing env vars. Check BOT_USERNAME and TWITCH_OAUTH_TOKEN in your .env"
  );
  process.exit(1);
}

/**
 * 2. Create Twitch client
 */
const client = new tmi.Client({
  options: { debug: true },
  connection: {
    reconnect: true,
    secure: true,
  },
  identity: {
    username: BOT_USERNAME,
    password: TWITCH_OAUTH_TOKEN,
  },
  channels,
});

/**
 * Track joined channels to prevent duplicate joins
 * (tmi expects channel names without '#')
 */
const joinedChannels = new Set(channels);

/**
 * Join polling interval handle
 */
let autoJoinInterval = null;

/**
 * Small delay between joins to avoid Twitch join rate limits
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch active channels from backend and join missing ones
 */
async function syncJoinsFromBackend() {
  try {
    const res = await axios.get(`${BACKEND_URL}/api/streamers/active`, {
      timeout: 10_000,
      validateStatus: () => true,
    });

    const data = res.data;

    if (!data || data.ok !== true || !Array.isArray(data.channels)) {
      console.warn("[AUTOJOIN] Unexpected response from backend:", data);
      return;
    }

    const list = data.channels
      .map((c) => String(c || "").trim().toLowerCase())
      .filter(Boolean);

    if (!list.length) return;

    for (const ch of list) {
      if (joinedChannels.has(ch)) continue;

      console.log(`[AUTOJOIN] Joining channel: ${ch}`);
      try {
        await client.join(ch);
        joinedChannels.add(ch);
        // spacing joins avoids rate limits / join floods
        await sleep(900);
      } catch (e) {
        console.error(`[AUTOJOIN] Failed to join ${ch}:`, e?.message || e);
      }
    }
  } catch (err) {
    console.error("[AUTOJOIN] Error talking to backend:", err?.message || err);
  }
}

// ---- GLOBAL DROP COOLDOWN ----
let lastGlobalDropAt = 0;
const GLOBAL_DROP_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * 3. Cooldowns + per-viewer discount cache
 */
const cooldowns = {};
const DEFAULT_COOLDOWN_MS = 10 * 1000; // fallback

function isOnCooldown(command, userId) {
  if (!cooldowns[command]) cooldowns[command] = {};
  const expiresAt = cooldowns[command][userId] || 0;
  const now = Date.now();
  return now < expiresAt ? Math.ceil((expiresAt - now) / 1000) : 0;
}

function setCooldown(command, userId, ms = DEFAULT_COOLDOWN_MS) {
  if (!cooldowns[command]) cooldowns[command] = {};
  cooldowns[command][userId] = Date.now() + ms;
}

// per-user discount cache (per process)
const claimedDiscounts = {};
const DISCOUNT_LIFETIME_MS = 10 * 60 * 1000; // 10 min

function getUserDiscount(channel, userId) {
  if (!claimedDiscounts[channel]) return null;
  const entry = claimedDiscounts[channel][userId];
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.createdAt > DISCOUNT_LIFETIME_MS) return null;
  return entry;
}

function setUserDiscount(channel, userId, code) {
  if (!claimedDiscounts[channel]) claimedDiscounts[channel] = {};
  claimedDiscounts[channel][userId] = { code, createdAt: Date.now() };
}

const COMMAND_COOLDOWNS = {
  ping: 1000,
  help: 2000,
  discount: 30 * 1000, // extra safety; per-viewer
  drop: GLOBAL_DROP_COOLDOWN_MS,
};

/**
 * 4. Helper to talk to backend
 */
async function callBackend(path, method = "POST", body = {}) {
  const url = `${BACKEND_URL}${path}`;
  const res = await axios({
    url,
    method,
    data: body,
    headers: { "Content-Type": "application/json" },
    validateStatus: () => true, // do NOT throw on non-2xx
  });

  if (typeof res.data === "object" && res.data !== null) return res.data;

  return {
    ok: false,
    error: `Backend returned HTTP ${res.status}`,
    status: res.status,
    raw: res.data,
  };
}

/**
 * 5. Commands
 */
const COMMANDS = {
  ping: {
    description: "Check if the bot is alive.",
    execute: async (channel, tags) => {
      await client.say(channel, `Pong! 🏓 @${tags["display-name"]}`);
    },
  },

  help: {
    description: "Show available commands.",
    execute: async (channel, tags) => {
      const commandList = Object.keys(COMMANDS)
        .map((c) => `${COMMAND_PREFIX}${c}`)
        .join(", ");
      await client.say(
        channel,
        `@${tags["display-name"]} Available commands: ${commandList}`
      );
    },
  },

  // PERSONAL VIEWER DISCOUNT
  discount: {
    description: "Get a personal discount code.",
    execute: async (channel, tags) => {
      const username = tags["display-name"] || tags.username;
      const userId = tags["user-id"] || username.toLowerCase();
      const twitchLogin = channel.replace("#", "").toLowerCase();

      const cd = isOnCooldown("discount", userId);
      if (cd > 0) {
        return client.say(
          channel,
          `@${username} wait ${cd}s before requesting another code.`
        );
      }

      await client.say(
        channel,
        `@${username} generating your personal discount code… ⏳`
      );

      try {
        const result = await requestViewerDiscount(twitchLogin, {
          id: userId,
          login: tags.username,
          displayName: username,
        });

        if (!result || typeof result.ok === "undefined") {
          console.error("Viewer discount API bad response:", result);
          return client.say(
            channel,
            `@${username} the Dropify API didn't respond correctly.`
          );
        }

        if (!result.ok) {
          if (result.reason === "plan_limit" && result.message) {
            return client.say(channel, `@${username} ${result.message}`);
          }

          switch (result.reason) {
            case "disabled":
              return client.say(
                channel,
                `@${username} Dropify discounts are currently disabled for this channel.`
              );
            case "not_connected":
              return client.say(
                channel,
                `@${username} Dropify is not fully connected to Shopify yet.`
              );
            case "cooldown":
              return client.say(
                channel,
                `@${username} Dropify is on cooldown, try again in about ${
                  result.retryAfterSeconds || 10
                } seconds.`
              );
            case "limit_reached": {
              const existing = getUserDiscount(channel, userId);
              if (existing?.code) {
                return client.say(
                  channel,
                  `🎁 @${username} you already claimed a discount this stream: ${existing.code}`
                );
              }
              return client.say(
                channel,
                `@${username} you've already redeemed your discount for this stream 🙌`
              );
            }
            case "not_found":
              return client.say(
                channel,
                `@${username} this channel isn't registered with Dropify yet.`
              );
            default:
              console.error("Viewer discount error reason:", result);
              return client.say(
                channel,
                `@${username} something went wrong while generating your discount.`
              );
          }
        }

        const code = result.discountCode;

        setUserDiscount(channel, userId, code);
        setCooldown("discount", userId, COMMAND_COOLDOWNS.discount);

        return client.say(
          channel,
          `🎁 @${username} your code: ${code} — valid for ~10 minutes!`
        );
      } catch (err) {
        console.error("Viewer discount error:", err?.response?.data || err);
        return client.say(
          channel,
          `@${username} something went wrong while generating your discount.`
        );
      }
    },
  },

  // GLOBAL DROP
  drop: {
    description: "Create a global stream-wide discount (streamer only).",
    execute: async (channel, tags, args) => {
      const username = tags["display-name"];
      const isStreamer = tags.badges && tags.badges.broadcaster === "1";
      const twitchLogin = channel.replace("#", "");

      if (!isStreamer) {
        return client.say(
          channel,
          `@${username} only the streamer can activate global drops.`
        );
      }

      const now = Date.now();
      const sinceLast = now - lastGlobalDropAt;
      if (sinceLast < GLOBAL_DROP_COOLDOWN_MS) {
        const remaining = Math.ceil(
          (GLOBAL_DROP_COOLDOWN_MS - sinceLast) / 1000
        );
        return client.say(
          channel,
          `@${username} global drop is on cooldown. Try again in ${remaining}s.`
        );
      }

      const percent = parseInt(args[0], 10);
      if (isNaN(percent) || percent < 1 || percent > 50) {
        return client.say(
          channel,
          `@${username} use: !drop <1-50> (example: !drop 10)`
        );
      }

      await client.say(
        channel,
        `🔥 @${username} is creating a global ${percent}% drop… stand by!`
      );

      try {
        const data = await callBackend(
          `/api/discounts/${twitchLogin}/global`,
          "POST",
          { percent }
        );

        if (!data?.ok) {
          if (data?.reason === "plan_limit" && data?.message) {
            return client.say(channel, `@${username} ${data.message}`);
          }

          if (data?.error) {
            return client.say(channel, `@${username} ${data.error}`);
          }

          return client.say(
            channel,
            `@${username} could not create a global drop (Shopify not configured?).`
          );
        }

        const code = data.drop.code;
        lastGlobalDropAt = Date.now();

        return client.say(
          channel,
          `🔥 GLOBAL DROP ACTIVATED! 🎁 Code: ${code} 💸 ${percent}% OFF for the next 10 minutes ⏳`
        );
      } catch (err) {
        const payload = err?.response?.data;
        if (payload?.reason === "plan_limit" && payload?.message) {
          return client.say(channel, `@${username} ${payload.message}`);
        }

        console.error("Global drop error:", payload || err);
        return client.say(
          channel,
          `@${username} something went wrong creating the drop.`
        );
      }
    },
  },

  // (Optional) owner-only demo command
  reload: {
    description: "Reload config (owner only).",
    execute: async (channel, tags) => {
      const user = tags.username?.toLowerCase();
      if (!OWNER_USERNAME || user !== OWNER_USERNAME.toLowerCase()) {
        return client.say(
          channel,
          `@${tags["display-name"]} You are not allowed to use this command.`
        );
      }

      // immediate sync + keep running interval
      await client.say(channel, `Reloading channel list…`);
      await syncJoinsFromBackend();
      return client.say(channel, `Channel list synced ✅`);
    },
  },
};

/**
 * 6. Connect + autojoin logic
 */
client.connect().catch((err) => {
  console.error("[ERROR] Failed to connect:", err);
});

client.on("connected", async (addr, port) => {
  console.log(`[INFO] Connected to ${addr}:${port}`);
  console.log(
    `[INFO] Static channels from .env: ${channels.map((c) => "#" + c).join(", ") || "(none)"}`
  );

  // Initial join sync
  console.log("[AUTOJOIN] Initial sync...");
  await syncJoinsFromBackend();

  // Start polling auto-join (only one interval)
  if (autoJoinInterval) clearInterval(autoJoinInterval);
  autoJoinInterval = setInterval(() => {
    syncJoinsFromBackend().catch(() => {});
  }, 60 * 1000);

  console.log("[AUTOJOIN] Polling enabled (every 60s).");
});

client.on("disconnected", (reason) => {
  console.warn("[WARN] Disconnected from Twitch:", reason);

  if (autoJoinInterval) {
    clearInterval(autoJoinInterval);
    autoJoinInterval = null;
  }
});

/**
 * 7. Main message handler
 */
client.on("message", async (channel, tags, message, self) => {
  if (self) return;
  const username = tags["display-name"] || tags.username;
  console.log(`[${channel}] ${username}: ${message}`);

  if (!message.startsWith(COMMAND_PREFIX)) return;

  const withoutPrefix = message.slice(COMMAND_PREFIX.length).trim();
  if (!withoutPrefix.length) return;

  const parts = withoutPrefix.split(/\s+/);
  const commandName = parts[0].toLowerCase();
  const args = parts.slice(1);

  const command = COMMANDS[commandName];
  if (!command) return;

  const userId = tags["user-id"] || username.toLowerCase();

  const cd = isOnCooldown(commandName, userId);
  if (cd > 0 && commandName !== "discount") {
    return client.say(
      channel,
      `@${username} wait ${cd}s before using ${COMMAND_PREFIX}${commandName} again.`
    );
  }

  try {
    await command.execute(channel, tags, args);

    if (commandName !== "discount") {
      const customCd = COMMAND_COOLDOWNS[commandName] || DEFAULT_COOLDOWN_MS;
      setCooldown(commandName, userId, customCd);
    }
  } catch (err) {
    console.error(`[ERROR] Command ${commandName} failed:`, err);
    return client.say(
      channel,
      `@${username} something went wrong executing ${COMMAND_PREFIX}${commandName}.`
    );
  }
});
