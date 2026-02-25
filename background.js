// ── background.js ──
// Service worker: receives messages from content.js and panel.js
// Makes direct calls to Anthropic API, streams responses back to panel

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-3-5-haiku-20241022";
const MAX_TOKENS = 1024;
const SUMMARY_THRESHOLD = 20; // messages before rolling summary kicks in
const KEEP_RECENT = 5; // messages to keep in full after summarising

// ── Message router ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SEND_PIN_QUESTION") {
    handlePinQuestion(message, sender);
    return true; // keep channel open for async
  }

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
});

// ── Main handler ──
async function handlePinQuestion(message, sender) {
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
      sendToPanel(sender.tab.id, {
        type: "PIN_ERROR",
        pinId,
        error: "No API key found. Open AnchorChat popup to add one.",
      });
      return;
    }

    // Build messages array for this pin's conversation
    let messages = buildMessages(
      conversationHistory,
      selectedText,
      question,
      contextMode,
      pageContext,
    );

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
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
        sendToPanel(sender.tab.id, {
          type: "PIN_ERROR",
          pinId,
          error:
            err.error?.message || "API error. Check your key and try again.",
        });
        return;
      }

      // Stream the response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "content_block_delta" && parsed.delta?.text) {
              sendToPanel(sender.tab.id, {
                type: "PIN_STREAM_CHUNK",
                pinId,
                chunk: parsed.delta.text,
              });
            }
            if (parsed.type === "message_stop") {
              sendToPanel(sender.tab.id, { type: "PIN_STREAM_DONE", pinId });
            }
          } catch (_) {
            // malformed chunk — skip
          }
        }
      }
    } catch (err) {
      sendToPanel(sender.tab.id, {
        type: "PIN_ERROR",
        pinId,
        error: "Network error. Check your connection and try again.",
      });
    }
  });
}

// ── Build messages array with rolling summary ──
function buildMessages(
  conversationHistory,
  selectedText,
  question,
  contextMode,
  pageContext,
) {
  let history = [...(conversationHistory || [])];

  // Apply rolling summary if history is long
  if (history.length > SUMMARY_THRESHOLD) {
    const older = history.slice(0, history.length - KEEP_RECENT);
    const recent = history.slice(history.length - KEEP_RECENT);
    const summaryText = summariseOlderMessages(older);
    history = [
      {
        role: "user",
        content: `[Earlier conversation summary]: ${summaryText}`,
      },
      {
        role: "assistant",
        content: "Understood, I have context from the earlier conversation.",
      },
      ...recent,
    ];
  }

  // Add current question
  history.push({
    role: "user",
    content: question,
  });

  return history;
}

// ── System prompt based on context mode ──
function buildSystemPrompt(contextMode, pageContext) {
  let base = `You are AnchorChat, a focused assistant helping the user understand or explore a specific piece of text they have selected and pinned.

Be concise, clear, and directly relevant to the selected text and question. Do not pad your responses.`;

  if (contextMode === "full" && pageContext) {
    base += `\n\nHere is the full conversation the user is reading, for context:\n\n${pageContext}`;
  } else if (contextMode === "surrounding" && pageContext) {
    base += `\n\nHere is the surrounding text near the user's selection:\n\n${pageContext}`;
  }

  return base;
}

// ── Simple extractive summary for older messages ──
function summariseOlderMessages(messages) {
  // Lightweight summary: pull first sentence of each assistant message
  const parts = messages
    .filter((m) => m.role === "assistant")
    .map((m) => {
      const text = typeof m.content === "string" ? m.content : "";
      return text.split(".")[0].trim();
    })
    .filter(Boolean)
    .slice(0, 6);

  return parts.length
    ? parts.join(". ") + "."
    : "Earlier conversation contained context about this topic.";
}

// ── Send message to panel ──
function sendToPanel(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    // panel may not be open yet — silently ignore
  });
}
