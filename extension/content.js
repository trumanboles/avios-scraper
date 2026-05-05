const BANNER_ID = "avios-reminder-banner";

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

function showBanner(payload) {
  removeBanner();

  const root = document.createElement("div");
  root.id = BANNER_ID;
  root.className = "avios-banner";

  const header = document.createElement("div");
  header.className = "avios-banner-header";

  const title = document.createElement("div");
  title.className = "avios-banner-title";
  title.textContent = payload.retailer.name;
  header.appendChild(title);

  const reward = document.createElement("div");
  reward.className = "avios-banner-reward";
  reward.textContent = payload.retailer.rate_text || "Earn Avios";

  const trust = document.createElement("div");
  trust.className = "avios-banner-context";
  trust.textContent = "Earn with Avios Shopping";

  const body = document.createElement("div");
  body.className = "avios-banner-copy";
  body.textContent = payload.isCheckout
    ? "Looks like checkout. Click through Avios first next time to collect points."
    : "Shop via Avios to collect points on this purchase. Takes 1 click at no extra cost.";

  const details = document.createElement("div");
  details.className = "avios-banner-meta";
  details.textContent = "Online purchases only. T&Cs apply.";

  const actions = document.createElement("div");
  actions.className = "avios-banner-actions";

  const dismissBtn = createButton("Not now", "avios-btn avios-btn-subtle", async () => {
    await chrome.runtime.sendMessage({
      type: "DISMISS_DOMAIN",
      domain: payload.matchedDomain
    });
    removeBanner();
  });
  actions.appendChild(dismissBtn);

  if (!payload.isCheckout) {
    const goBtn = createButton("Shop & earn Avios", "avios-btn avios-btn-primary", async () => {
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

  root.appendChild(header);
  root.appendChild(reward);
  root.appendChild(trust);
  root.appendChild(body);
  root.appendChild(details);
  root.appendChild(actions);
  document.documentElement.appendChild(root);

  requestAnimationFrame(() => {
    root.classList.add("is-visible");
  });

}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "SHOW_BANNER" && msg.payload) {
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
