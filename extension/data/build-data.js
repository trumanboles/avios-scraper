#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const rootRetailersPath = path.resolve(__dirname, "../../retailers.json");
const outputPath = path.resolve(__dirname, "./retailers.json");

function normalizeDomain(input) {
  if (!input || typeof input !== "string") return null;
  return input.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

function makeRetailerSummary(retailer) {
  return {
    slug: retailer.slug,
    name: retailer.name,
    avios_url: retailer.avios_url,
    rate_text: retailer.rate_text || "",
    was_rate: retailer.was_rate || "",
    image_url: retailer.image_url || "",
    is_speedy: Boolean(retailer.is_speedy),
    categories: Array.isArray(retailer.categories) ? retailer.categories : [],
    domains: Array.isArray(retailer.domains) ? retailer.domains : [],
    domain_source: retailer.domain_source || "guess"
  };
}

function buildDomainMap(raw) {
  const domainMap = {};
  const retailersBySlug = {};

  for (const retailer of Object.values(raw.retailers || {})) {
    const summary = makeRetailerSummary(retailer);
    retailersBySlug[summary.slug] = summary;

    for (const d of summary.domains) {
      const domain = normalizeDomain(d);
      if (!domain) continue;
      if (!domainMap[domain]) {
        domainMap[domain] = summary;
      }
    }
  }

  return {
    generated_at: Math.floor(Date.now() / 1000),
    source: raw.source || "",
    scraped_at: raw.scraped_at || null,
    count: raw.count || Object.keys(retailersBySlug).length,
    domain_map: domainMap,
    retailers: retailersBySlug
  };
}

function main() {
  if (!fs.existsSync(rootRetailersPath)) {
    throw new Error(`Input file not found: ${rootRetailersPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(rootRetailersPath, "utf8"));
  const built = buildDomainMap(raw);
  fs.writeFileSync(outputPath, JSON.stringify(built, null, 2) + "\n", "utf8");

  console.log(
    `Built ${Object.keys(built.retailers).length} retailers and ${Object.keys(
      built.domain_map
    ).length} unique domains -> ${outputPath}`
  );
}

main();
