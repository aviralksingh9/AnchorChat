// ── popup.js ──

const PROVIDER_INFO = {
  anthropic: {
    info: 'Get your key at <a href="https://platform.anthropic.com/settings/keys" target="_blank">platform.anthropic.com</a>. Paid plans only — $5 minimum credit.',
    placeholder: "sk-ant-...",
    label: "Anthropic API Key",
    badge: "badge-anthropic",
    name: "Anthropic",
  },
  openai: {
    info: 'Get your key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>. New accounts get $5 free credit.',
    placeholder: "sk-...",
    label: "OpenAI API Key",
    badge: "badge-openai",
    name: "OpenAI",
  },
  gemini: {
    info: '✅ Completely free tier available. Get your key at <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com</a>. No credit card needed.',
    placeholder: "AIza...",
    label: "Gemini API Key",
    badge: "badge-gemini",
    name: "Gemini",
  },
};

let selectedProvider = "anthropic";

const screenSetup = document.getElementById("screen-setup");
const screenSettings = document.getElementById("screen-settings");
const apiKeyInput = document.getElementById("api-key-input");
const saveBtn = document.getElementById("save-btn");
const statusMsg = document.getElementById("status-msg");
const keyDisplay = document.getElementById("key-display");
const providerBadge = document.getElementById("provider-badge");
const changeKeyBtn = document.getElementById("change-key-btn");
const providerInfo = document.getElementById("provider-info");
const keyLabel = document.getElementById("key-label");
const providerTabs = document.querySelectorAll(".provider-tab");
const contextOptions = document.querySelectorAll(".context-option");
const radioInputs = document.querySelectorAll('input[name="context"]');

// ── Init ──
chrome.storage.local.get(
  ["anchorchat_api_key", "anchorchat_provider", "anchorchat_context_mode"],
  (r) => {
    if (r["anchorchat_api_key"]) {
      showSettingsScreen(
        r["anchorchat_api_key"],
        r["anchorchat_provider"] || "anthropic",
        r["anchorchat_context_mode"] || "full",
      );
    } else {
      showSetupScreen();
    }
  },
);

// ── Provider tab switching ──
providerTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    selectedProvider = tab.dataset.provider;
    providerTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const info = PROVIDER_INFO[selectedProvider];
    providerInfo.innerHTML = info.info;
    keyLabel.textContent = info.label;
    apiKeyInput.placeholder = info.placeholder;
    apiKeyInput.value = "";
    statusMsg.textContent = "";
  });
});

// ── Save ──
saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showStatus("Paste your API key first.", "error");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  chrome.storage.local.set(
    {
      anchorchat_api_key: key,
      anchorchat_provider: selectedProvider,
    },
    () => {
      showStatus("Saved!", "success");
      setTimeout(() => showSettingsScreen(key, selectedProvider, "full"), 800);
    },
  );
});

// ── Change key ──
changeKeyBtn.addEventListener("click", () => {
  chrome.storage.local.remove(
    ["anchorchat_api_key", "anchorchat_provider"],
    showSetupScreen,
  );
});

// ── Context mode ──
radioInputs.forEach((radio) => {
  radio.addEventListener("change", () => {
    chrome.storage.local.set({ anchorchat_context_mode: radio.value });
    updateSelectedOption(radio.value);
  });
});

// ── Screen helpers ──
function showSetupScreen() {
  screenSetup.classList.add("active");
  screenSettings.classList.remove("active");
  apiKeyInput.value = "";
  statusMsg.textContent = "";
  saveBtn.disabled = false;
  saveBtn.textContent = "Save & Activate";
  selectedProvider = "anthropic";
  providerTabs.forEach((t) =>
    t.classList.toggle("active", t.dataset.provider === "anthropic"),
  );
  const info = PROVIDER_INFO["anthropic"];
  providerInfo.innerHTML = info.info;
  keyLabel.textContent = info.label;
  apiKeyInput.placeholder = info.placeholder;
}

function showSettingsScreen(key, provider, contextMode) {
  screenSetup.classList.remove("active");
  screenSettings.classList.add("active");
  keyDisplay.textContent = key.slice(0, 12) + "••••••••••••";
  const info = PROVIDER_INFO[provider] || PROVIDER_INFO["anthropic"];
  providerBadge.textContent = info.name;
  providerBadge.className = "provider-badge " + info.badge;
  radioInputs.forEach((r) => {
    r.checked = r.value === contextMode;
  });
  updateSelectedOption(contextMode);
}

function updateSelectedOption(value) {
  contextOptions.forEach((opt) => {
    opt.classList.toggle(
      "selected",
      opt.querySelector("input").value === value,
    );
  });
}

function showStatus(msg, type) {
  statusMsg.textContent = msg;
  statusMsg.className = "status-msg " + type;
}
