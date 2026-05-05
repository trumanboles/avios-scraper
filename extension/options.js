function normalizeDomain(domain) {
  return String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.+$/, "");
}

function formatTs(ts) {
  if (!ts) return "unknown";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "unknown";
  }
}

async function getSettings() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  return response.settings;
}

async function saveSettings(patch) {
  return chrome.runtime.sendMessage({ type: "SET_SETTINGS", patch });
}

function renderSkipList(items) {
  const list = document.getElementById("skip-list");
  list.innerHTML = "";
  for (const domain of items) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${domain}</span><button class="pill" data-domain="${domain}" type="button">Remove</button>`;
    list.appendChild(li);
  }
  list.querySelectorAll("button[data-domain]").forEach((button) => {
    button.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        type: "SET_SKIP_DOMAIN",
        domain: button.getAttribute("data-domain"),
        skip: false
      });
      await init();
    });
  });
}

async function init() {
  const settings = await getSettings();
  document.getElementById("verified-only").checked = Boolean(settings.verifiedOnly);
  renderSkipList((settings.skipDomains || []).slice().sort());

  const local = await chrome.storage.local.get(["lastUpdatedTs"]);
  document.getElementById("last-updated").textContent = `Last updated: ${formatTs(
    local.lastUpdatedTs
  )}`;
}

document.getElementById("verified-only").addEventListener("change", async (evt) => {
  await saveSettings({ verifiedOnly: evt.target.checked });
});

document.getElementById("add-skip").addEventListener("click", async () => {
  const input = document.getElementById("skip-domain-input");
  const domain = normalizeDomain(input.value);
  if (!domain) return;
  await chrome.runtime.sendMessage({ type: "SET_SKIP_DOMAIN", domain, skip: true });
  input.value = "";
  await init();
});

document.getElementById("refresh-data").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "MANUAL_REFRESH" });
  const prefix = result?.result?.ok ? "Refresh succeeded" : "Refresh failed";
  document.getElementById("last-updated").textContent = `${prefix}: ${formatTs(
    result.lastUpdatedTs
  )}`;
});

init();
