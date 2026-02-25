// ── popup.js ──
// Handles: API key save/load, screen switching, context mode setting

const STORAGE_KEYS = {
  API_KEY: "anchorchat_api_key",
  CONTEXT_MODE: "anchorchat_context_mode",
};

// ── Elements ──
const screenOnboarding = document.getElementById("screen-onboarding");
const screenSettings = document.getElementById("screen-settings");
const apiKeyInput = document.getElementById("api-key-input");
const saveBtn = document.getElementById("save-btn");
const statusMsg = document.getElementById("status-msg");
const keyDisplay = document.getElementById("key-display");
const changeKeyBtn = document.getElementById("change-key-btn");
const contextOptions = document.querySelectorAll(".context-option");
const radioInputs = document.querySelectorAll('input[name="context"]');

// ── Init: check if key already saved ──
chrome.storage.local.get(
  [STORAGE_KEYS.API_KEY, STORAGE_KEYS.CONTEXT_MODE],
  (result) => {
    if (result[STORAGE_KEYS.API_KEY]) {
      showSettingsScreen(
        result[STORAGE_KEYS.API_KEY],
        result[STORAGE_KEYS.CONTEXT_MODE] || "full",
      );
    } else {
      showOnboardingScreen();
    }
  },
);

// ── Save key ──
saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    showStatus("Paste your API key first.", "error");
    return;
  }

  if (!key.startsWith("sk-ant-")) {
    showStatus("Key should start with sk-ant-", "error");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: key }, () => {
    showStatus("Saved!", "success");
    setTimeout(() => showSettingsScreen(key, "full"), 800);
  });
});

// ── Change key button ──
changeKeyBtn.addEventListener("click", () => {
  chrome.storage.local.remove(STORAGE_KEYS.API_KEY, () => {
    showOnboardingScreen();
  });
});

// ── Context mode toggle ──
radioInputs.forEach((radio) => {
  radio.addEventListener("change", () => {
    const value = radio.value;
    chrome.storage.local.set({ [STORAGE_KEYS.CONTEXT_MODE]: value });
    updateSelectedOption(value);
  });
});

// ── Screen helpers ──
function showOnboardingScreen() {
  screenOnboarding.classList.add("active");
  screenSettings.classList.remove("active");
  apiKeyInput.value = "";
  statusMsg.textContent = "";
  saveBtn.disabled = false;
  saveBtn.textContent = "Save & Activate";
}

function showSettingsScreen(key, contextMode) {
  screenOnboarding.classList.remove("active");
  screenSettings.classList.add("active");

  // Mask key: show first 10 chars + ...
  keyDisplay.textContent = key.slice(0, 10) + "••••••••••••••••••••";

  // Set radio to saved mode
  radioInputs.forEach((r) => {
    r.checked = r.value === contextMode;
  });
  updateSelectedOption(contextMode);
}

function updateSelectedOption(value) {
  contextOptions.forEach((opt) => {
    const radio = opt.querySelector('input[type="radio"]');
    opt.classList.toggle("selected", radio.value === value);
  });
}

function showStatus(msg, type) {
  statusMsg.textContent = msg;
  statusMsg.className = "status-msg " + type;
}
