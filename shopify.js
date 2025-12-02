require("dotenv").config();
const axios = require("axios");

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

if (!STORE_DOMAIN || !ADMIN_TOKEN) {
  throw new Error("Missing Shopify environment variables.");
}

const BASE_URL = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}`;

/* -----------------------------------
   CREATE PERSONAL PRICE RULE
----------------------------------- */
async function createPriceRule() {
  const body = {
    price_rule: {
      title: `Dropify Auto Rule ${Date.now()}`,
      target_type: "line_item",
      target_selection: "all",
      allocation_method: "across",
      value_type: "percentage",
      value: "-10.0",

      customer_selection: "all",
      once_per_customer: false,
      usage_limit: 1,

      starts_at: new Date(Date.now() - 1000).toISOString(),
      ends_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
  };

  const res = await axios.post(`${BASE_URL}/price_rules.json`, body, {
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
  });

  return res.data.price_rule;
}

/* -----------------------------------
   CREATE PERSONAL DISCOUNT CODE
----------------------------------- */
async function createDiscountCode(priceRuleId, username) {
  const random = Math.floor(1000 + Math.random() * 9000);
  const code = `DROP-${username.toUpperCase()}-${random}`;

  const body = {
    discount_code: { code },
  };

  const res = await axios.post(
    `${BASE_URL}/price_rules/${priceRuleId}/discount_codes.json`,
    body,
    {
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );

  return {
    code,
    url: `https://${STORE_DOMAIN}/discount/${code}`,
    id: res.data.discount_code.id,
  };
}

/* -----------------------------------
   PERSONAL VIEWER DROP
----------------------------------- */
async function createDiscountForViewer(username) {
  const priceRule = await createPriceRule();
  const discount = await createDiscountCode(priceRule.id, username);
  return discount;
}

/* -----------------------------------
   GLOBAL DROP
----------------------------------- */
async function createGlobalDrop(code, percent) {
  const body = {
    price_rule: {
      title: `Dropify Global Drop ${code}`,
      target_type: "line_item",
      target_selection: "all",
      allocation_method: "across",
      value_type: "percentage",
      value: `-${percent}.0`,
      customer_selection: "all",

      usage_limit: null,
      once_per_customer: false,

      starts_at: new Date(Date.now() - 1000).toISOString(),
      ends_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
  };

  const ruleRes = await axios.post(`${BASE_URL}/price_rules.json`, body, {
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
  });

  const priceRuleId = ruleRes.data.price_rule.id;

  const codeBody = {
    discount_code: { code },
  };

  const codeRes = await axios.post(
    `${BASE_URL}/price_rules/${priceRuleId}/discount_codes.json`,
    codeBody,
    {
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );

  return codeRes.data.discount_code;
}

/* -----------------------------------
   EXPORT ALL FUNCTIONS PROPERLY
----------------------------------- */
module.exports = {
  createDiscountForViewer,
  createGlobalDrop,
};
