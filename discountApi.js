// /opt/dropify/dropify-bot/discountApi.js
const fetch = require("node-fetch");

const API_URL = process.env.DROPIFY_API_URL || "https://api.dropifybot.com";

/**
 * Safe JSON parse helper
 */
async function readJsonOrText(res) {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const raw = await res.text();

  if (contentType.includes("application/json")) {
    try {
      return { kind: "json", data: JSON.parse(raw) };
    } catch (_) {
      return { kind: "text", data: raw };
    }
  }

  // Sometimes backend still returns JSON but without proper header
  try {
    return { kind: "json", data: JSON.parse(raw) };
  } catch (_) {
    return { kind: "text", data: raw };
  }
}

/**
 * Call Dropify backend to create a viewer discount.
 *
 * streamerLogin: Twitch channel login (e.g. "dropifybot")
 * viewer: { id, login, displayName }
 */
async function requestViewerDiscount(streamerLogin, viewer) {
  const url = `${API_URL}/api/discounts/${encodeURIComponent(
    (streamerLogin || "").toLowerCase()
  )}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        viewerId: viewer?.id,
        viewerLogin: viewer?.login,
        viewerDisplayName: viewer?.displayName,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "network_error",
      message: "Failed to reach Dropify API.",
      error: err?.message || String(err),
    };
  }

  const parsed = await readJsonOrText(res);

  // If backend gave us JSON, prefer it (even on non-2xx) because it contains reason/message
  if (parsed.kind === "json" && parsed.data && typeof parsed.data === "object") {
    return {
      ...parsed.data,
      httpStatus: res.status,
    };
  }

  // Non-JSON fallback
  return {
    ok: false,
    reason: res.status === 404 ? "not_found" : "http_error",
    message: `Dropify API returned HTTP ${res.status}`,
    httpStatus: res.status,
    raw: typeof parsed.data === "string" ? parsed.data.slice(0, 500) : parsed.data,
  };
}

module.exports = {
  requestViewerDiscount,
};
