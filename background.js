// ── background.js ──
const MAX_TOKENS = 1024;
const SUMMARY_THRESHOLD = 20;
const KEEP_RECENT = 5;

const PROVIDERS = {
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    model: "claude-3-5-haiku-20241022",
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent",
    model: "gemini-1.5-flash",
  },
};

// ── Panel port ──
let panelPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "anchorchat-panel") {
    panelPort = port;
    port.onDisconnect.addListener(() => {
      panelPort = null;
    });
    port.onMessage.addListener((message) => {
      if (message.type === "SEND_PIN_QUESTION") handlePinQuestion(message);
    });
  }
});

// ── Message router ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_API_KEY") {
    chrome.storage.local.get(
      ["anchorchat_api_key", "anchorchat_provider"],
      (r) => {
        sendResponse({
          key: r["anchorchat_api_key"] || null,
          provider: r["anchorchat_provider"] || "anthropic",
        });
      },
    );
    return true;
  }

  if (message.type === "OPEN_SIDE_PANEL") {
    if (sender.tab && sender.tab.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id });
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) chrome.sidePanel.open({ tabId: tabs[0].id });
      });
    }
    return true;
  }

  if (message.type === "NEW_PIN") {
    sendToPanel(message);
    return true;
  }
});

// ── Main handler ──
async function handlePinQuestion(message) {
  const { pinId, question, conversationHistory, contextMode, pageContext } =
    message;

  chrome.storage.local.get(
    ["anchorchat_api_key", "anchorchat_provider"],
    async (r) => {
      const apiKey = r["anchorchat_api_key"];
      const provider = r["anchorchat_provider"] || "anthropic";

      if (!apiKey) {
        sendToPanel({
          type: "PIN_ERROR",
          pinId,
          error: "No API key found. Click the AnchorChat icon to add one.",
        });
        return;
      }

      try {
        const systemPrompt = buildSystemPrompt(contextMode, pageContext);
        const history = buildMessages(conversationHistory, question);

        if (provider === "anthropic") {
          await callAnthropic(apiKey, pinId, systemPrompt, history);
        } else if (provider === "openai") {
          await callOpenAI(apiKey, pinId, systemPrompt, history);
        } else if (provider === "gemini") {
          await callGemini(apiKey, pinId, systemPrompt, history);
        }
      } catch (err) {
        console.error("[AnchorChat] Error:", err);
        sendToPanel({
          type: "PIN_ERROR",
          pinId,
          error: "Error: " + err.message,
        });
      }
    },
  );
}

// ── Anthropic ──
async function callAnthropic(apiKey, pinId, systemPrompt, messages) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      max_tokens: MAX_TOKENS,
      stream: true,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    sendToPanel({
      type: "PIN_ERROR",
      pinId,
      error: err.error?.message || `Anthropic error ${response.status}`,
    });
    return;
  }

  await streamSSE(response, pinId, (parsed) => {
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
  });
}

// ── OpenAI ──
async function callOpenAI(apiKey, pinId, systemPrompt, messages) {
  const openaiMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: openaiMessages,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    sendToPanel({
      type: "PIN_ERROR",
      pinId,
      error: err.error?.message || `OpenAI error ${response.status}`,
    });
    return;
  }

  await streamSSE(response, pinId, (parsed) => {
    const chunk = parsed.choices?.[0]?.delta?.content;
    if (chunk) sendToPanel({ type: "PIN_STREAM_CHUNK", pinId, chunk });
    if (parsed.choices?.[0]?.finish_reason === "stop") {
      sendToPanel({ type: "PIN_STREAM_DONE", pinId });
    }
  });
}

// ── Gemini ──
async function callGemini(apiKey, pinId, systemPrompt, messages) {
  // Convert messages to Gemini format
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${apiKey}&alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
      }),
    },
  );

  if (!response.ok) {
    const err = await response.json();
    sendToPanel({
      type: "PIN_ERROR",
      pinId,
      error: err.error?.message || `Gemini error ${response.status}`,
    });
    return;
  }

  await streamSSE(response, pinId, (parsed) => {
    const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
    if (chunk) sendToPanel({ type: "PIN_STREAM_CHUNK", pinId, chunk });
    if (parsed.candidates?.[0]?.finishReason === "STOP") {
      sendToPanel({ type: "PIN_STREAM_DONE", pinId });
    }
  });
}

// ── Generic SSE streamer ──
async function streamSSE(response, pinId, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneSent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        if (!doneSent) {
          sendToPanel({ type: "PIN_STREAM_DONE", pinId });
          doneSent = true;
        }
        continue;
      }
      try {
        onChunk(JSON.parse(data));
      } catch (_) {}
    }
  }

  if (!doneSent) sendToPanel({ type: "PIN_STREAM_DONE", pinId });
}

// ── Build messages ──
function buildMessages(conversationHistory, question) {
  let history = [...(conversationHistory || [])];
  if (history.length > SUMMARY_THRESHOLD) {
    const older = history.slice(0, history.length - KEEP_RECENT);
    const recent = history.slice(history.length - KEEP_RECENT);
    history = [
      { role: "user", content: `[Summary]: ${summarise(older)}` },
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

function summarise(messages) {
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
  }
}
