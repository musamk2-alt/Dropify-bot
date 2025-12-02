// /opt/dropify/dropify-bot/discountApi.js
const fetch = require("node-fetch");

const API_URL = process.env.DROPIFY_API_URL || "https://api.dropifybot.com";

/**
 * Call Dropify backend to create a viewer discount.
 *
 * streamerLogin: Twitch channel login (e.g. "dropifybot")
 * viewer: { id, login, displayName }
 */
async function requestViewerDiscount(streamerLogin, viewer) {
  const url = `${API_URL}/api/discounts/${encodeURIComponent(
    streamerLogin.toLowerCase()
  )}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      viewerId: viewer.id,
      viewerLogin: viewer.login,
      viewerDisplayName: viewer.displayName,
    }),
  });

  const data = await res.json();
  return data;
}

module.exports = {
  requestViewerDiscount,
};
