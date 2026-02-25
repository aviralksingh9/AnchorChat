// ── content.js ──
// Runs on every page.
// Responsibilities:
//   1. Detect text selection → show ⚓ bubble
//   2. On bubble click → send selected text to panel + scrape context
//   3. DOM scraper for claude.ai (Smart Mode) and generic pages (Universal Mode)
//   4. Relay messages between background.js and panel.js

(function () {
  "use strict";

  const IS_CLAUDE = window.location.hostname === "claude.ai";

  let bubble = null;
  let lastSelection = "";
  let lastRange = null;

  // ── Create bubble ──
  function createBubble() {
    const el = document.createElement("div");
    el.id = "anchorchat-bubble";
    el.textContent = "⚓";
    el.style.cssText = `
      position: absolute;
      z-index: 2147483647;
      background: #7c6af7;
      color: white;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      cursor: pointer;
      box-shadow: 0 2px 12px rgba(124,106,247,0.5);
      transition: transform 0.15s, opacity 0.15s;
      opacity: 0;
      pointer-events: none;
      user-select: none;
    `;
    document.body.appendChild(el);

    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onBubbleClick();
    });

    return el;
  }

  function showBubble(x, y) {
    if (!bubble) bubble = createBubble();
    bubble.style.left = x + window.scrollX + "px";
    bubble.style.top = y + window.scrollY - 52 + "px";
    bubble.style.opacity = "1";
    bubble.style.pointerEvents = "auto";
    bubble.style.transform = "scale(1)";
  }

  function hideBubble() {
    if (!bubble) return;
    bubble.style.opacity = "0";
    bubble.style.pointerEvents = "none";
    bubble.style.transform = "scale(0.8)";
  }

  // ── Selection detection ──
  // Use selectionchange + mouseup combo for reliability on claude.ai
  let selectionTimer = null;

  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();

      if (!text || text.length < 2) {
        hideBubble();
        return;
      }

      lastSelection = text;
      try {
        lastRange = selection.getRangeAt(0);
        const rect = lastRange.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        const x = rect.left + rect.width / 2 - 16;
        const y = rect.top;
        showBubble(x, y);
      } catch (_) {}
    }, 200);
  });

  document.addEventListener("mouseup", (e) => {
    // Extra trigger on mouseup as backup
    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (!text || text.length < 2) return;
      lastSelection = text;
      try {
        lastRange = selection.getRangeAt(0);
        const rect = lastRange.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        const x = rect.left + rect.width / 2 - 16;
        const y = rect.top;
        showBubble(x, y);
      } catch (_) {}
    }, 250);
  });

  // Hide bubble when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (bubble && e.target !== bubble) {
      hideBubble();
    }
  });

  // Hide on scroll
  document.addEventListener("scroll", hideBubble, { passive: true });

  // ── Bubble click: pin the selection ──
  function onBubbleClick() {
    if (!lastSelection) return;

    hideBubble();

    const pageContext = IS_CLAUDE
      ? scrapeClaudeConversation()
      : scrapeUniversalContext(lastRange);

    // Open side panel via background
    chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" });

    // Capture before clearing
    const pinnedText = lastSelection;
    lastSelection = "";
    lastRange = null;

    // Send pin data to panel (delay to let panel open)
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: "NEW_PIN",
        selectedText: pinnedText,
        pageContext,
        contextMode: null,
      });
    }, 500);
  }

  // ── Smart Mode: Scrape claude.ai conversation ──
  function scrapeClaudeConversation() {
    try {
      // Target conversational message blocks semantically
      // We look for alternating user/assistant message containers
      // Strategy: find large text blocks that alternate in structure

      const results = [];

      // Approach: find all elements that look like message containers
      // claude.ai wraps messages in divs with data attributes or role patterns
      // We use a broad selector and filter by content

      const candidates = document.querySelectorAll(
        '[data-testid*="message"], [class*="message"], [class*="Message"], ' +
          '[class*="human"], [class*="assistant"], [class*="turn"]',
      );

      if (candidates.length >= 2) {
        candidates.forEach((el) => {
          const text = el.innerText?.trim();
          if (text && text.length > 20) {
            // Detect role from data attributes or class
            const isHuman = /human|user/i.test(
              el.getAttribute("data-testid") || el.className || "",
            );
            results.push({
              role: isHuman ? "Human" : "Assistant",
              text: text.slice(0, 800),
            });
          }
        });
      }

      // Fallback: semantic block scraping
      if (results.length < 2) {
        return scrapeSemanticBlocks();
      }

      return formatConversation(results);
    } catch (err) {
      return null; // fail silently — panel handles missing context
    }
  }

  // ── Semantic fallback scraper ──
  function scrapeSemanticBlocks() {
    try {
      // Find the main content area
      const main = document.querySelector("main") || document.body;
      const blocks = Array.from(main.querySelectorAll("p, div"))
        .filter((el) => {
          const text = el.innerText?.trim();
          return text && text.length > 50 && el.children.length < 5;
        })
        .map((el) => el.innerText.trim().slice(0, 600));

      // Deduplicate adjacent identical blocks
      const deduped = blocks.filter((b, i) => b !== blocks[i - 1]);

      if (deduped.length === 0) return null;

      return deduped.slice(-20).join("\n\n---\n\n"); // last 20 blocks
    } catch (_) {
      return null;
    }
  }

  // ── Universal Mode: Surrounding paragraph context ──
  function scrapeUniversalContext(range) {
    try {
      if (!range) return null;

      const container = range.commonAncestorContainer;
      const parent =
        container.nodeType === 3 ? container.parentElement : container;

      // Walk up to find a section-level container
      let section = parent;
      for (let i = 0; i < 4; i++) {
        if (!section.parentElement) break;
        section = section.parentElement;
        const tag = section.tagName?.toLowerCase();
        if (
          ["article", "section", "main", "div"].includes(tag) &&
          section.innerText?.length > 200
        )
          break;
      }

      const fullText = section?.innerText?.trim() || "";
      if (!fullText) return null;

      // Find selection position within the text and grab ~5 lines around it
      const selText = lastSelection;
      const idx = fullText.indexOf(selText);
      if (idx === -1) return fullText.slice(0, 1000);

      const start = Math.max(0, idx - 400);
      const end = Math.min(fullText.length, idx + selText.length + 400);
      return fullText.slice(start, end);
    } catch (_) {
      return null;
    }
  }

  function formatConversation(messages) {
    return messages.map((m) => `${m.role}:\n${m.text}`).join("\n\n---\n\n");
  }

  // ── Relay: background → panel ──
  // background.js sends streaming chunks to the tab (content script)
  // We forward them to the panel via runtime messaging
  chrome.runtime.onMessage.addListener((message) => {
    if (
      ["PIN_STREAM_CHUNK", "PIN_STREAM_DONE", "PIN_ERROR"].includes(
        message.type,
      )
    ) {
      // Forward to panel.js (panel listens on runtime messages too)
      // Panel is in the same extension context so it receives directly
      // No relay needed — background sends to tab, panel listens on runtime
    }
  });
})();
