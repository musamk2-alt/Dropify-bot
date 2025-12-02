require("dotenv").config();

// Node 18+ has global fetch. If you’re on older Node:
// npm install node-fetch
// const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

if (!STORE_DOMAIN || !ADMIN_TOKEN) {
  console.error("❌ Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN in .env");
  process.exit(1);
}

async function testListProducts() {
  const url = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/products.json`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
  });

  console.log("➡️ GET", url);
  console.log("Status:", res.status);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify error: ${res.status} - ${text}`);
  }

  const data = await res.json();
  console.log("✅ Products received (showing first 1):");
  console.dir(data.products?.[0], { depth: 4 });
}

async function testCreateDummyDiscount() {
  const url = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/price_rules.json`;

  const body = {
    price_rule: {
      title: "Dropify Test 10% OFF",
      target_type: "line_item",
      target_selection: "all",
      allocation_method: "across",
      value_type: "percentage",
      value: "-10.0",                  // minus sign for discount
      customer_selection: "all",
      once_per_customer: false,
      usage_limit: 5,                  // so you don’t blow up your store
      starts_at: new Date().toISOString(),
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  console.log("➡️ POST", url);
  console.log("Status:", res.status);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify error (price rule): ${res.status} - ${text}`);
  }

  const data = await res.json();
  console.log("✅ Price rule created");
  console.dir(data.price_rule, { depth: 4 });

  const priceRuleId = data.price_rule.id;

  // Now create the actual discount code under that rule
  const discountUrl = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/price_rules/${priceRuleId}/discount_codes.json`;

  const codeBody = {
    discount_code: {
      code: "DROPIFYTEST10",          // later: something like `${twitchUser}_10OFF`
    },
  };

  const res2 = await fetch(discountUrl, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(codeBody),
  });

  console.log("➡️ POST", discountUrl);
  console.log("Status:", res2.status);

  if (!res2.ok) {
    const text = await res2.text();
    throw new Error(`Shopify error (discount code): ${res2.status} - ${text}`);
  }

  const data2 = await res2.json();
  console.log("✅ Discount code created:");
  console.dir(data2.discount_code, { depth: 4 });

  console.log(`🎉 Use discount code: ${data2.discount_code.code}`);
}

(async () => {
  try {
    console.log("=== 1) Testing product list ===");
    await testListProducts();

    console.log("\n=== 2) Testing discount creation ===");
    await testCreateDummyDiscount();

    console.log("\n✅ All Shopify tests passed.");
  } catch (err) {
    console.error("❌ Error during Shopify test:");
    console.error(err);
  }
})();
