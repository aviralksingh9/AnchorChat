// ── background.js ──
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-3-5-haiku-20241022";
const MAX_TOKENS = 1024;
const SUMMARY_THRESHOLD = 20;
const KEEP_RECENT = 5;

// ── Panel port ──
let panelPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "anchorchat-panel") {
    panelPort = port;
    console.log("[AnchorChat] Panel connected");

    port.onDisconnect.addListener(() => {
      panelPort = null;
      console.log("[AnchorChat] Panel disconnected");
    });

    port.onMessage.addListener((message) => {
      if (message.type === "SEND_PIN_QUESTION") {
        handlePinQuestion(message);
      }
    });
  }
});

// ── Message router (from content.js) ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_API_KEY") {
    chrome.storage.local.get("anchorchat_api_key", (r) => {
      sendResponse({ key: r["anchorchat_api_key"] || null });
    });
    return true;
  }

  if (message.type === "OPEN_SIDE_PANEL") {
    if (sender.tab && sender.tab.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id });
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].id) chrome.sidePanel.open({ tabId: tabs[0].id });
      });
    }
    return true;
  }

  if (message.type === "NEW_PIN") {
    sendToPanel(message);
    return true;
  }
});

// ── Main API handler ──
async function handlePinQuestion(message) {
  const {
    pinId,
    selectedText,
    question,
    conversationHistory,
    contextMode,
    pageContext,
  } = message;

  chrome.storage.local.get("anchorchat_api_key", async (r) => {
    const apiKey = r["anchorchat_api_key"];

    if (!apiKey) {
      sendToPanel({
        type: "PIN_ERROR",
        pinId,
        error: "No API key found. Click the AnchorChat icon to add one.",
      });
      return;
    }

    const messages = buildMessages(conversationHistory, question);

    try {
      console.log("[AnchorChat] Calling Anthropic API...");
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          stream: true,
          system: buildSystemPrompt(contextMode, pageContext),
          messages,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        console.error("[AnchorChat] API error:", err);
        sendToPanel({
          type: "PIN_ERROR",
          pinId,
          error: err.error?.message || `API error ${response.status}`,
        });
        return;
      }

      console.log("[AnchorChat] Streaming...");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "content_block_delta" && parsed.delta?.text) {
              sendToPanel({
                type: "PIN_STREAM_CHUNK",
                pinId,
                chunk: parsed.delta.text,
              });
            }
            if (parsed.type === "message_stop") {
              sendToPanel({ type: "PIN_STREAM_DONE", pinId });
            }
          } catch (_) {}
        }
      }
    } catch (err) {
      console.error("[AnchorChat] Error:", err);
      sendToPanel({
        type: "PIN_ERROR",
        pinId,
        error: "Network error: " + err.message,
      });
    }
  });
}

function buildMessages(conversationHistory, question) {
  let history = [...(conversationHistory || [])];
  if (history.length > SUMMARY_THRESHOLD) {
    const older = history.slice(0, history.length - KEEP_RECENT);
    const recent = history.slice(history.length - KEEP_RECENT);
    history = [
      { role: "user", content: `[Summary]: ${summariseOlderMessages(older)}` },
      { role: "assistant", content: "Understood." },
      ...recent,
    ];
  }
  history.push({ role: "user", content: question });
  return history;
}

function buildSystemPrompt(contextMode, pageContext) {
  let base = `You are AnchorChat, a focused assistant helping the user understand a specific piece of text they selected. Be concise and directly relevant.`;
  if (contextMode === "full" && pageContext)
    base += `\n\nFull conversation context:\n\n${pageContext}`;
  else if (contextMode === "surrounding" && pageContext)
    base += `\n\nSurrounding context:\n\n${pageContext}`;
  return base;
}

function summariseOlderMessages(messages) {
  const parts = messages
    .filter((m) => m.role === "assistant")
    .map((m) =>
      (typeof m.content === "string" ? m.content : "").split(".")[0].trim(),
    )
    .filter(Boolean)
    .slice(0, 6);
  return parts.length
    ? parts.join(". ") + "."
    : "Earlier conversation context.";
}

function sendToPanel(message) {
  if (panelPort) {
    try {
      panelPort.postMessage(message);
    } catch (e) {
      console.error("[AnchorChat] Panel send failed:", e);
    }
  } else {
    console.warn("[AnchorChat] Panel not connected:", message.type);
  }
}
