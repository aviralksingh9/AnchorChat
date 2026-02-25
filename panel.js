// ── panel.js ──
// Manages pin cards, conversation history per card, sends questions to background.js

(function () {
  "use strict";

  // ── State ──
  const pins = new Map(); // pinId → { selectedText, pageContext, history: [] }
  let pinCounter = 0;

  // ── DOM refs ──
  const pinsContainer = document.getElementById("pins-container");
  const emptyState = document.getElementById("empty-state");
  const clearAllBtn = document.getElementById("clear-all-btn");
  const noKeyBanner = document.getElementById("no-key-banner");

  // ── Check API key on load ──
  chrome.runtime.sendMessage({ type: "GET_API_KEY" }, (res) => {
    if (!res?.key) {
      noKeyBanner.style.display = "block";
    }
  });

  // ── Connect to background via persistent port ──
  const port = chrome.runtime.connect({ name: "anchorchat-panel" });

  port.onMessage.addListener((message) => {
    switch (message.type) {
      case "NEW_PIN":
        createPinCard(message.selectedText, message.pageContext);
        break;
      case "PIN_STREAM_CHUNK":
        appendChunk(message.pinId, message.chunk);
        break;
      case "PIN_STREAM_DONE":
        finaliseStream(message.pinId);
        break;
      case "PIN_ERROR":
        showCardError(message.pinId, message.error);
        break;
    }
  });

  // runtime.onMessage not needed — NEW_PIN comes via port from background

  // Expose port for sendQuestion
  window._anchorPort = port;

  // ── Clear all pins ──
  clearAllBtn.addEventListener("click", () => {
    pins.clear();
    pinsContainer.innerHTML = "";
    showEmpty(true);
  });

  // ── Create a new pin card ──
  function createPinCard(selectedText, pageContext) {
    const pinId = "pin-" + ++pinCounter;

    pins.set(pinId, {
      selectedText,
      pageContext,
      history: [],
      streaming: false,
      streamBuffer: "",
    });

    showEmpty(false);

    const card = document.createElement("div");
    card.className = "pin-card";
    card.id = pinId;
    card.innerHTML = `
      <div class="card-header">
        <div style="flex:1; min-width:0">
          <div class="card-label">⚓ Pinned text</div>
          <div class="selected-text">${escapeHtml(selectedText)}</div>
        </div>
        <button class="card-close" data-pin="${pinId}" title="Remove pin">✕</button>
      </div>
      <div class="card-messages" id="msgs-${pinId}"></div>
      <div class="card-input-area">
        <textarea
          class="card-textarea"
          id="input-${pinId}"
          placeholder="Ask something about this…"
          rows="1"
        ></textarea>
        <button class="send-btn" id="send-${pinId}" title="Send">↑</button>
      </div>
    `;

    pinsContainer.prepend(card); // newest on top

    // Auto-resize textarea
    const textarea = document.getElementById("input-" + pinId);
    textarea.addEventListener("input", () => autoResize(textarea));

    // Send on Enter (Shift+Enter = newline)
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendQuestion(pinId);
      }
    });

    // Send button
    document.getElementById("send-" + pinId).addEventListener("click", () => {
      sendQuestion(pinId);
    });

    // Close button
    card.querySelector(".card-close").addEventListener("click", () => {
      removePin(pinId);
    });

    // Focus input
    setTimeout(() => textarea.focus(), 100);
  }

  // ── Send question ──
  function sendQuestion(pinId) {
    const pin = pins.get(pinId);
    if (!pin || pin.streaming) return;

    const textarea = document.getElementById("input-" + pinId);
    const question = textarea.value.trim();
    if (!question) return;

    textarea.value = "";
    autoResize(textarea);

    // Add user message to UI
    addMessage(pinId, "user", question);

    // Add to history
    pin.history.push({ role: "user", content: question });

    // Show typing indicator
    showTyping(pinId);
    pin.streaming = true;
    pin.streamBuffer = "";
    document.getElementById("send-" + pinId).disabled = true;

    // Read context mode from storage then fire
    chrome.storage.local.get("anchorchat_context_mode", (r) => {
      const contextMode = r["anchorchat_context_mode"] || "full";

      const msg = {
        type: "SEND_PIN_QUESTION",
        pinId,
        selectedText: pin.selectedText,
        question,
        conversationHistory: buildApiHistory(pin.history),
        contextMode,
        pageContext: contextMode === "none" ? null : pin.pageContext,
      };
      if (window._anchorPort) {
        window._anchorPort.postMessage(msg);
      } else {
        chrome.runtime.sendMessage(msg);
      }
    });
  }

  // ── Build API history (exclude current question — it's the last user message) ──
  function buildApiHistory(history) {
    // Return all messages except the last one (current question sent separately)
    return history.slice(0, -1);
  }

  // ── Append streaming chunk ──
  function appendChunk(pinId, chunk) {
    const pin = pins.get(pinId);
    if (!pin) return;

    removeTyping(pinId);

    // Find or create the current assistant message bubble
    let msgEl = document.getElementById("streaming-msg-" + pinId);
    if (!msgEl) {
      msgEl = createMessageEl("assistant");
      msgEl.id = "streaming-msg-" + pinId;
      document.getElementById("msgs-" + pinId).appendChild(msgEl);
    }

    pin.streamBuffer += chunk;
    msgEl.querySelector(".msg-text").textContent = pin.streamBuffer;
    scrollToBottom(pinId);
  }

  // ── Finalise stream ──
  function finaliseStream(pinId) {
    const pin = pins.get(pinId);
    if (!pin) return;

    // Save complete assistant message to history
    if (pin.streamBuffer) {
      pin.history.push({ role: "assistant", content: pin.streamBuffer });
    }

    // Remove streaming id so next response creates a fresh bubble
    const msgEl = document.getElementById("streaming-msg-" + pinId);
    if (msgEl) msgEl.removeAttribute("id");

    pin.streaming = false;
    pin.streamBuffer = "";

    const sendBtn = document.getElementById("send-" + pinId);
    if (sendBtn) sendBtn.disabled = false;

    const textarea = document.getElementById("input-" + pinId);
    if (textarea) textarea.focus();
  }

  // ── Show error in card ──
  function showCardError(pinId, error) {
    removeTyping(pinId);

    const pin = pins.get(pinId);
    if (!pin) return;

    pin.streaming = false;
    const sendBtn = document.getElementById("send-" + pinId);
    if (sendBtn) sendBtn.disabled = false;

    const msgs = document.getElementById("msgs-" + pinId);
    if (!msgs) return;

    const errEl = document.createElement("div");
    errEl.className = "msg-error";
    errEl.textContent = "⚠ " + error;
    msgs.appendChild(errEl);
    scrollToBottom(pinId);
  }

  // ── Remove pin ──
  function removePin(pinId) {
    pins.delete(pinId);
    document.getElementById(pinId)?.remove();
    if (pins.size === 0) showEmpty(true);
  }

  // ── UI helpers ──

  function addMessage(pinId, role, text) {
    const msgs = document.getElementById("msgs-" + pinId);
    if (!msgs) return;
    const el = createMessageEl(role);
    el.querySelector(".msg-text").textContent = text;
    msgs.appendChild(el);
    scrollToBottom(pinId);
  }

  function createMessageEl(role) {
    const el = document.createElement("div");
    el.className = "msg " + role;
    el.innerHTML = `
      <div class="msg-role">${role === "user" ? "You" : "Claude"}</div>
      <div class="msg-text"></div>
    `;
    return el;
  }

  function showTyping(pinId) {
    const msgs = document.getElementById("msgs-" + pinId);
    if (!msgs) return;
    const el = document.createElement("div");
    el.id = "typing-" + pinId;
    el.className = "typing-indicator";
    el.innerHTML =
      '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    msgs.appendChild(el);
    scrollToBottom(pinId);
  }

  function removeTyping(pinId) {
    document.getElementById("typing-" + pinId)?.remove();
  }

  function scrollToBottom(pinId) {
    const msgs = document.getElementById("msgs-" + pinId);
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  function showEmpty(show) {
    emptyState.style.display = show ? "flex" : "none";
  }

  function autoResize(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 100) + "px";
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
