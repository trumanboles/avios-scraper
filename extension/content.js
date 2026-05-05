const BANNER_ID = "avios-reminder-banner";

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

debugLog({
  location: "content.js:top-level",
  message: "Content script loaded",
  data: { href: location.href },
  hypothesisId: "H3"
});

function removeBanner() {
  const existing = document.getElementById(BANNER_ID);
  if (existing) existing.remove();
}

function createButton(label, className, onClick) {
  const button = document.createElement("button");
  button.textContent = label;
  button.className = className;
  button.addEventListener("click", onClick);
  return button;
}

function formatDisplayUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "") + parsed.pathname;
  } catch {
    return url || "";
  }
}

function showBanner(payload) {
  removeBanner();

  const root = document.createElement("div");
  root.id = BANNER_ID;
  root.className = "avios-banner";

  const title = document.createElement("div");
  title.className = "avios-banner-title";
  title.textContent = payload.retailer.name;

  const body = document.createElement("div");
  body.className = "avios-banner-copy";
  body.textContent = payload.isCheckout
    ? "Looks like checkout. Next time, click through Avios first to earn points."
    : `${payload.retailer.rate_text || "Earn Avios"} available at this store.`;

  const details = document.createElement("div");
  details.className = "avios-banner-copy";
  const rateText = payload.retailer.rate_text || "Earn Avios";
  const aviosPath = formatDisplayUrl(payload.retailer.avios_url);
  details.textContent = `Rate: ${rateText} | Link: ${aviosPath}`;

  const actions = document.createElement("div");
  actions.className = "avios-banner-actions";

  const dismissBtn = createButton("Dismiss", "avios-btn avios-btn-subtle", async () => {
    await chrome.runtime.sendMessage({
      type: "DISMISS_DOMAIN",
      domain: payload.matchedDomain
    });
    removeBanner();
  });
  actions.appendChild(dismissBtn);

  if (!payload.isCheckout) {
    const goBtn = createButton("Shop via Avios", "avios-btn avios-btn-primary", async () => {
      await chrome.runtime.sendMessage({
        type: "OPEN_AVIOS",
        url: payload.retailer.avios_url
      });
      await chrome.runtime.sendMessage({
        type: "DISMISS_DOMAIN",
        domain: payload.matchedDomain
      });
      removeBanner();
    });
    actions.appendChild(goBtn);
  }

  root.appendChild(title);
  root.appendChild(body);
  root.appendChild(details);
  root.appendChild(actions);
  document.documentElement.appendChild(root);

  requestAnimationFrame(() => {
    root.classList.add("is-visible");
  });

  setTimeout(() => {
    removeBanner();
  }, 15000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "SHOW_BANNER" && msg.payload) {
    debugLog({
      location: "content.js:onMessage",
      message: "SHOW_BANNER received",
      data: { href: location.href, matchedDomain: msg.payload.matchedDomain },
      hypothesisId: "H1"
    });
    showBanner(msg.payload);
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "GET_PAGE_CONTEXT") {
    sendResponse({
      referrer: document.referrer || "",
      url: location.href
    });
  }
});
