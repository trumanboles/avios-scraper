const BUNDLED_DATA_PATH = "data/retailers.json";
const DEFAULT_REMOTE_DATA_URL =
  "https://raw.githubusercontent.com/trumanboles/avios-scraper/main/extension/data/retailers.json";
const REFRESH_ALARM = "weeklyRetailerRefresh";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISS_MS = 30 * 60 * 1000;

const AFFILIATE_HOST_HINTS = [
  "avios.com",
  "awin",
  "rakuten",
  "skimlinks",
  "linksynergy",
  "impact.com",
  "cj.com",
  "partnerize",
  "webgains"
];

const CHECKOUT_HINTS = ["checkout", "basket", "cart", "payment", "order"];

const DEFAULT_SETTINGS = {
  verifiedOnly: false,
  skipDomains: [],
  remoteDataUrl: DEFAULT_REMOTE_DATA_URL
};

function debugLog({ location, message, data, hypothesisId, runId = "pre-fix" }) {
  // #region agent log
  fetch("http://127.0.0.1:7565/ingest/cef98efd-1734-4272-810d-05b050153ec8", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "2bd336"
    },
    body: JSON.stringify({
      sessionId: "2bd336",
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
}

const pendingBannerByTabId = new Map();

let runtimeData = {
  domain_map: {},
  retailers: {},
  count: 0,
  lastUpdated: null,
  source: "bundled"
};
const bootstrapPromise = initializeData();

function normalizeDomain(domain) {
  return String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.+$/, "");
}

function getCandidateDomains(hostname) {
  const normalized = normalizeDomain(hostname);
  if (!normalized) return [];

  const parts = normalized.split(".").filter(Boolean);
  const candidates = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    candidates.push(parts.slice(i).join("."));
  }
  return candidates;
}

function domainIsAffiliate(referrerHost) {
  const host = normalizeDomain(referrerHost);
  return AFFILIATE_HOST_HINTS.some((hint) => host.includes(hint));
}

function isCheckoutLike(urlString) {
  try {
    const u = new URL(urlString);
    const haystack = `${u.pathname} ${u.search}`.toLowerCase();
    return CHECKOUT_HINTS.some((hint) => haystack.includes(hint));
  } catch {
    return false;
  }
}

async function getSettings() {
  const current = await chrome.storage.local.get(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(current.settings || {}) };
}

async function setSettings(patch) {
  const settings = await getSettings();
  const { reminderMode: _ignoredReminderMode, ...safePatch } = patch || {};
  const next = { ...settings, ...safePatch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function loadBundledData() {
  const response = await fetch(chrome.runtime.getURL(BUNDLED_DATA_PATH));
  if (!response.ok) throw new Error(`Bundled data load failed: ${response.status}`);
  return response.json();
}

async function fetchRemoteData(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Remote data fetch failed: ${response.status}`);
  return response.json();
}

function applyRuntimeData(payload, sourceLabel) {
  runtimeData = {
    domain_map: payload.domain_map || {},
    retailers: payload.retailers || {},
    count: payload.count || Object.keys(payload.retailers || {}).length,
    source: sourceLabel,
    lastUpdated: Date.now()
  };
}

async function initializeData() {
  const local = await chrome.storage.local.get(["cachedRetailersData"]);
  if (local.cachedRetailersData?.domain_map) {
    applyRuntimeData(local.cachedRetailersData, "cached");
    return;
  }

  const bundled = await loadBundledData();
  applyRuntimeData(bundled, "bundled");
  await chrome.storage.local.set({
    cachedRetailersData: bundled,
    lastUpdatedTs: Date.now()
  });
}

async function refreshData() {
  const settings = await getSettings();
  try {
    const payload = await fetchRemoteData(settings.remoteDataUrl);
    if (!payload?.domain_map || !payload?.retailers) {
      throw new Error("Remote payload missing domain_map/retailers");
    }
    applyRuntimeData(payload, "remote");
    await chrome.storage.local.set({
      cachedRetailersData: payload,
      lastUpdatedTs: Date.now()
    });
    return { ok: true, source: "remote" };
  } catch (err) {
    console.warn("Retailer refresh failed, keeping local cache:", err);
    return { ok: false, error: String(err) };
  }
}

async function getReferrerFromTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_CONTEXT" });
    debugLog({
      location: "background.js:getReferrerFromTab",
      message: "GET_PAGE_CONTEXT succeeded",
      data: { tabId, hasReferrer: Boolean(response?.referrer) },
      hypothesisId: "H2"
    });
    return response?.referrer || "";
  } catch (err) {
    debugLog({
      location: "background.js:getReferrerFromTab",
      message: "GET_PAGE_CONTEXT failed",
      data: { tabId, error: String(err) },
      hypothesisId: "H2"
    });
    return "";
  }
}

function matchRetailerByHost(hostname) {
  for (const candidate of getCandidateDomains(hostname)) {
    const retailer = runtimeData.domain_map[candidate];
    if (retailer) {
      return { matchedDomain: candidate, retailer };
    }
  }
  return null;
}

async function shouldSuppressReminder({ matchedDomain, retailer, referrer, settings }) {
  let refHost = "";
  if (referrer) {
    try {
      refHost = new URL(referrer).hostname;
    } catch {
      refHost = "";
    }
  }
  if (refHost && domainIsAffiliate(refHost)) return true;

  const normalizedDomain = normalizeDomain(matchedDomain);
  const skipSet = new Set((settings.skipDomains || []).map(normalizeDomain));
  if (skipSet.has(normalizedDomain)) return true;

  if (settings.verifiedOnly && !["override", "click_out"].includes(retailer.domain_source)) {
    return true;
  }

  const session = await chrome.storage.session.get(["dismissedUntilByDomain"]);
  const dismissedUntilByDomain = session.dismissedUntilByDomain || {};
  if ((dismissedUntilByDomain[normalizedDomain] || 0) > Date.now()) return true;

  return false;
}

async function setTabBadge(tabId, text, title = "") {
  await chrome.action.setBadgeBackgroundColor({ color: "#0A7A2D", tabId });
  await chrome.action.setBadgeText({ text, tabId });
  await chrome.action.setTitle({ tabId, title: title || "Avios Reminder" });
}

async function clearTabBadge(tabId) {
  await chrome.action.setBadgeText({ text: "", tabId });
}

async function processNavigation(details) {
  await bootstrapPromise;
  if (details.frameId !== 0 || details.tabId < 0 || !details.url.startsWith("http")) return;
  const url = new URL(details.url);
  const match = matchRetailerByHost(url.hostname);
  if (!match) {
    await clearTabBadge(details.tabId);
    return;
  }

  const settings = await getSettings();
  const referrer = await getReferrerFromTab(details.tabId);
  const suppressed = await shouldSuppressReminder({
    matchedDomain: match.matchedDomain,
    retailer: match.retailer,
    referrer,
    settings
  });

  const session = await chrome.storage.session.get(["tabRetailerMatches"]);
  const tabRetailerMatches = session.tabRetailerMatches || {};
  tabRetailerMatches[String(details.tabId)] = {
    matchedDomain: match.matchedDomain,
    retailer: match.retailer,
    url: details.url,
    isCheckout: isCheckoutLike(details.url),
    referrer
  };
  await chrome.storage.session.set({ tabRetailerMatches });

  if (suppressed) {
    debugLog({
      location: "background.js:processNavigation",
      message: "Reminder suppressed",
      data: { tabId: details.tabId, url: details.url, matchedDomain: match.matchedDomain },
      hypothesisId: "H4"
    });
    await clearTabBadge(details.tabId);
    return;
  }

  debugLog({
    location: "background.js:processNavigation",
    message: "Attempting SHOW_BANNER send",
    data: {
      tabId: details.tabId,
      url: details.url,
      matchedDomain: match.matchedDomain,
      isCheckout: isCheckoutLike(details.url)
    },
    hypothesisId: "H1"
  });
  await setTabBadge(details.tabId, "✓", `${match.retailer.name} offers Avios`);
  try {
    const bannerMessage = {
      type: "SHOW_BANNER",
      payload: {
        retailer: match.retailer,
        matchedDomain: match.matchedDomain,
        isCheckout: isCheckoutLike(details.url)
      }
    };
    await chrome.tabs.sendMessage(details.tabId, bannerMessage);
    debugLog({
      location: "background.js:processNavigation",
      message: "SHOW_BANNER acknowledged by content script",
      data: { tabId: details.tabId, matchedDomain: match.matchedDomain },
      hypothesisId: "H1"
    });
  } catch (err) {
    debugLog({
      location: "background.js:processNavigation",
      message: "SHOW_BANNER send failed",
      data: { tabId: details.tabId, url: details.url, error: String(err) },
      hypothesisId: "H1"
    });
    if (String(err).includes("Receiving end does not exist")) {
      pendingBannerByTabId.set(details.tabId, {
        message: bannerMessage,
        matchedDomain: match.matchedDomain,
        url: details.url
      });
      debugLog({
        location: "background.js:processNavigation",
        message: "Queued SHOW_BANNER retry for tab completion",
        data: { tabId: details.tabId, matchedDomain: match.matchedDomain },
        hypothesisId: "H5",
        runId: "post-fix"
      });
      return;
    }
    throw err;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await initializeData();
  await refreshData();
  await chrome.alarms.create(REFRESH_ALARM, {
    periodInMinutes: WEEK_MS / (60 * 1000)
  });
});

chrome.runtime.onStartup.addListener(async () => {
  await initializeData();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === REFRESH_ALARM) {
    await refreshData();
  }
});

chrome.webNavigation.onCommitted.addListener(processNavigation, {
  url: [{ schemes: ["http", "https"] }]
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const pending = pendingBannerByTabId.get(tabId);
  if (!pending) return;

  try {
    await chrome.tabs.sendMessage(tabId, pending.message);
    pendingBannerByTabId.delete(tabId);
    debugLog({
      location: "background.js:tabs.onUpdated",
      message: "Queued SHOW_BANNER retry delivered after tab complete",
      data: { tabId, matchedDomain: pending.matchedDomain, url: pending.url },
      hypothesisId: "H5",
      runId: "post-fix"
    });
  } catch (err) {
    debugLog({
      location: "background.js:tabs.onUpdated",
      message: "Queued SHOW_BANNER retry failed after tab complete",
      data: { tabId, matchedDomain: pending.matchedDomain, error: String(err) },
      hypothesisId: "H5",
      runId: "post-fix"
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await bootstrapPromise;
    if (msg?.type === "DISMISS_DOMAIN") {
      const domain = normalizeDomain(msg.domain);
      const current = await chrome.storage.session.get(["dismissedUntilByDomain"]);
      const dismissedUntilByDomain = current.dismissedUntilByDomain || {};
      dismissedUntilByDomain[domain] = Date.now() + DISMISS_MS;
      await chrome.storage.session.set({ dismissedUntilByDomain });
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "OPEN_AVIOS") {
      if (!msg.url) {
        sendResponse({ ok: false });
        return;
      }
      await chrome.tabs.create({ url: msg.url, active: true });
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "GET_TAB_STATE") {
      const tabId = msg.tabId || sender.tab?.id;
      const current = await chrome.storage.session.get(["tabRetailerMatches"]);
      const tabRetailerMatches = current.tabRetailerMatches || {};
      const matched = tabRetailerMatches[String(tabId)] || null;
      const settings = await getSettings();
      sendResponse({
        ok: true,
        matched,
        settings,
        lastUpdatedTs: (await chrome.storage.local.get(["lastUpdatedTs"])).lastUpdatedTs || null
      });
      return;
    }

    if (msg?.type === "SEARCH_RETAILERS") {
      const query = String(msg.query || "").trim().toLowerCase();
      const all = Object.values(runtimeData.retailers);
      if (!query) {
        sendResponse({ ok: true, items: all.slice(0, 30) });
        return;
      }
      const matches = all
        .filter(
          (r) =>
            r.name.toLowerCase().includes(query) ||
            r.slug.toLowerCase().includes(query) ||
            (r.domains || []).some((d) => d.toLowerCase().includes(query))
        )
        .slice(0, 50);
      sendResponse({ ok: true, items: matches });
      return;
    }

    if (msg?.type === "SET_SKIP_DOMAIN") {
      const settings = await getSettings();
      const domain = normalizeDomain(msg.domain);
      const skipSet = new Set((settings.skipDomains || []).map(normalizeDomain));
      if (msg.skip) skipSet.add(domain);
      else skipSet.delete(domain);
      const next = await setSettings({ skipDomains: [...skipSet].filter(Boolean).sort() });
      sendResponse({ ok: true, settings: next });
      return;
    }

    if (msg?.type === "GET_SETTINGS") {
      sendResponse({ ok: true, settings: await getSettings() });
      return;
    }

    if (msg?.type === "SET_SETTINGS") {
      const next = await setSettings(msg.patch || {});
      sendResponse({ ok: true, settings: next });
      return;
    }

    if (msg?.type === "MANUAL_REFRESH") {
      const result = await refreshData();
      sendResponse({ ok: true, result, lastUpdatedTs: Date.now() });
      return;
    }
  })();

  return true;
});
