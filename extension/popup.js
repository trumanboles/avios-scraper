async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c];
  });
}

async function renderPartner(app, tabState) {
  const { matched, settings } = tabState;
  const skipDomains = new Set((settings.skipDomains || []).map((d) => d.toLowerCase()));
  const skipChecked = skipDomains.has((matched.matchedDomain || "").toLowerCase());
  const isCheckout = matched.isCheckout;

  app.innerHTML = `
    <div class="card">
      <div class="name">${esc(matched.retailer.name)}</div>
      <div class="muted">${esc(matched.retailer.rate_text || "Earn Avios")}</div>
      <div class="muted">Matched domain: ${esc(matched.matchedDomain)}</div>
      ${
        isCheckout
          ? `<div class="muted" style="margin-top:6px">Checkout page detected. Best to use Avios at the start of shopping next time.</div>`
          : ""
      }
      <div class="actions">
        ${
          isCheckout
            ? ""
            : `<button id="go-avios" class="primary">Go via Avios</button>`
        }
      </div>
      <label class="muted" style="display:flex;gap:8px;align-items:center;margin-top:10px;">
        <input id="skip-domain" type="checkbox" ${skipChecked ? "checked" : ""}/>
        Never remind me on this domain
      </label>
    </div>
  `;

  const goBtn = document.getElementById("go-avios");
  if (goBtn) {
    goBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        type: "OPEN_AVIOS",
        url: matched.retailer.avios_url
      });
      window.close();
    });
  }

  document.getElementById("skip-domain").addEventListener("change", async (evt) => {
    await chrome.runtime.sendMessage({
      type: "SET_SKIP_DOMAIN",
      domain: matched.matchedDomain,
      skip: evt.target.checked
    });
  });
}

async function renderSearch(app) {
  app.innerHTML = `
    <div class="card">
      <div class="muted">This site is not currently recognized as an Avios partner.</div>
      <div style="margin-top:8px;">
        <input id="search" type="search" placeholder="Search retailers or domains..." />
      </div>
      <ul id="results"></ul>
    </div>
  `;

  const search = document.getElementById("search");
  const results = document.getElementById("results");

  async function runSearch() {
    const query = search.value || "";
    const res = await chrome.runtime.sendMessage({ type: "SEARCH_RETAILERS", query });
    const items = res.items || [];
    results.innerHTML = items
      .map(
        (r) => `
        <li>
          <div class="name">${esc(r.name)}</div>
          <div class="muted">${esc(r.rate_text || "")}</div>
          <div class="muted">${esc((r.domains || []).slice(0, 2).join(", "))}</div>
          <div style="margin-top:6px;"><button class="subtle" data-url="${esc(r.avios_url)}">Open on Avios</button></div>
        </li>`
      )
      .join("");

    results.querySelectorAll("button[data-url]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({
          type: "OPEN_AVIOS",
          url: btn.getAttribute("data-url")
        });
        window.close();
      });
    });
  }

  search.addEventListener("input", runSearch);
  await runSearch();
}

async function init() {
  const app = document.getElementById("app");
  const tab = await getActiveTab();
  if (!tab?.id) {
    app.textContent = "No active tab.";
    return;
  }

  const state = await chrome.runtime.sendMessage({
    type: "GET_TAB_STATE",
    tabId: tab.id
  });

  if (state?.matched) {
    await renderPartner(app, state);
  } else {
    await renderSearch(app);
  }
}

init();
