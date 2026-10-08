/* ═══════════════════════════════════════════════════════════
   DocQuery — Frontend Controller
   ═══════════════════════════════════════════════════════════ */

// ─── DOM ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const app = document.querySelector(".app");
const messages = $("messages");
const emptyState = $("emptyState");
const queryInput = $("queryInput");
const sendBtn = $("sendBtn");
const dropZone = $("dropZone");
const fileInput = $("fileInput");
const uploadStatus = $("uploadStatus");
const uploadProgress = $("uploadProgress");
const progressFill = $("progressFill");
const progressText = $("progressText");
const docList = $("docList");
const docCount = $("docCount");
const themeToggle = $("themeToggle");
const sidebarToggle = $("sidebarToggle");
const sidebarOverlay = $("sidebarOverlay");
const newChatBtn = $("newChatBtn");
const toastContainer = $("toastContainer");
const deleteModal = $("deleteModal");
const deleteFilename = $("deleteFilename");
const modalConfirm = $("modalConfirm");
const modalCancel = $("modalCancel");
const modalClose = $("modalClose");

let isLoading = false;
let abortController = null;
let pendingDelete = null;

// ─── Theme ──────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem("docquery-theme");
  if (saved) {
    document.documentElement.setAttribute("data-theme", saved);
  }
}

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("docquery-theme", next);
});

initTheme();

// ─── Sidebar ────────────────────────────────────────────────
sidebarToggle.addEventListener("click", () => {
  app.classList.toggle("sidebar-collapsed");
});

function openMobileSidebar() {
  app.classList.add("sidebar-open");
  sidebarOverlay.classList.add("active");
  sidebarOverlay.setAttribute("aria-hidden", "false");
}

function closeMobileSidebar() {
  app.classList.remove("sidebar-open");
  sidebarOverlay.classList.remove("active");
  sidebarOverlay.setAttribute("aria-hidden", "true");
}

sidebarOverlay.addEventListener("click", closeMobileSidebar);

const sidebarToggleMobile = $("sidebarToggleMobile");
if (sidebarToggleMobile) {
  sidebarToggleMobile.addEventListener("click", openMobileSidebar);
}

// ─── Toasts ─────────────────────────────────────────────────
const TOAST_ICONS = {
  success:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function showToast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" aria-label="Dismiss">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;

  const remove = () => {
    el.classList.add("removing");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };

  el.querySelector(".toast-close").addEventListener("click", remove);
  toastContainer.appendChild(el);
  setTimeout(remove, 5000);
}

// ─── Init ───────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadDocuments();
  queryInput.focus();

  if (typeof marked !== "undefined") {
    marked.setOptions({ breaks: true, gfm: true });
  }
});

// ─── Chat (Streaming) ───────────────────────────────────────

async function sendMessage(text) {
  // If a response is streaming, the button acts as "stop"
  if (isLoading) {
    if (abortController) abortController.abort();
    return;
  }

  text = text.trim();
  if (!text) return;

  isLoading = true;
  hideEmptyState();
  addMessage("user", text);
  queryInput.value = "";
  queryInput.style.height = "auto";
  updateSendBtn();
  setStreamingState(true);

  const thinkingEl = showThinking();

  abortController = new AbortController();

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text }),
      signal: abortController.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Server error (${res.status})`);
    }

    thinkingEl.remove();

    // Create assistant message container
    const aiEl = document.createElement("div");
    aiEl.className = "message assistant";
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    aiEl.innerHTML = `
      <div class="message-header">
        <span class="message-avatar">AI</span>
        <span class="message-role">Assistant</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-body streaming-cursor"></div>
    `;
    messages.appendChild(aiEl);
    scrollToBottom();

    const bodyEl = aiEl.querySelector(".message-body");
    let fullText = "";
    let sources = null;

    // Parse SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const raw of events) {
        const lines = raw.split("\n");
        let event = "message";
        let data = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          if (line.startsWith("data: ")) data = line.slice(6);
        }

        if (event === "sources" && data) {
          try {
            sources = JSON.parse(data);
          } catch (_) {}
        } else if (event === "token" && data) {
          fullText += data;
          bodyEl.innerHTML = renderMarkdown(fullText);
          scrollToBottom();
        } else if (event === "error") {
          throw new Error(data || "Stream error");
        }
      }
    }

    // Finalize
    bodyEl.classList.remove("streaming-cursor");
    bodyEl.innerHTML = renderMarkdown(fullText);
    addCodeCopyButtons(bodyEl);

    if (sources && sources.length) {
      addSources(aiEl, sources);
    }

    scrollToBottom();
  } catch (err) {
    thinkingEl.remove();

    if (err.name === "AbortError") {
      showToast("Generation stopped", "info");
      // Remove the partial assistant message if empty
      const last = messages.querySelector(".message.assistant:last-child");
      if (last && !last.querySelector(".message-body")?.textContent.trim()) {
        last.remove();
      } else if (last) {
        last.querySelector(".message-body")?.classList.remove("streaming-cursor");
      }
    } else {
      addErrorMessage(err.message || "Something went wrong. Try again.");
      showToast(err.message || "Request failed", "error");
      console.error(err);
    }
  } finally {
    isLoading = false;
    abortController = null;
    setStreamingState(false);
    updateSendBtn();
  }
}

function setStreamingState(streaming) {
  sendBtn.classList.toggle("streaming", streaming);
}

function renderMarkdown(text) {
  if (typeof marked !== "undefined") {
    return marked.parse(text);
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function addMessage(role, content, sources) {
  const div = document.createElement("div");
  div.className = `message ${role}`;

  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const label = role === "user" ? "You" : "Assistant";
  const avatar = role === "user" ? "U" : "AI";

  const bodyHtml =
    role === "ai" || role === "assistant"
      ? renderMarkdown(content)
      : escapeHtml(content).replace(/\n/g, "<br>");

  div.innerHTML = `
    <div class="message-header">
      <span class="message-avatar">${avatar}</span>
      <span class="message-role">${label}</span>
      <span class="message-time">${time}</span>
    </div>
    <div class="message-body">${bodyHtml}</div>
  `;

  if ((role === "ai" || role === "assistant") && sources && sources.length) {
    addSources(div, sources);
  }

  if (role === "ai" || role === "assistant") {
    addCodeCopyButtons(div);
  }

  messages.appendChild(div);
  scrollToBottom();
}

function addSources(container, sources) {
  const pages = [...new Set(sources.map((s) => s.page))];
  const pills = pages
    .map(
      (p) =>
        `<span class="source-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>p.${p}</span>`
    )
    .join("");

  const div = document.createElement("div");
  div.className = "message-sources";
  div.innerHTML = `<span class="source-label">Sources</span>${pills}`;
  container.appendChild(div);
}

function addErrorMessage(text) {
  const div = document.createElement("div");
  div.className = "message assistant error";
  div.innerHTML = `
    <div class="message-header">
      <span class="message-avatar">AI</span>
      <span class="message-role">Error</span>
    </div>
    <div class="message-body">⚠ ${escapeHtml(text)}</div>
  `;
  messages.appendChild(div);
  scrollToBottom();
}

function showThinking() {
  const div = document.createElement("div");
  div.className = "thinking";
  div.innerHTML = `
    <div class="thinking-content">
      <div class="thinking-dots"><span></span><span></span><span></span></div>
      Searching documents…
    </div>
  `;
  messages.appendChild(div);
  scrollToBottom();
  return div;
}

function hideEmptyState() {
  if (emptyState) emptyState.style.display = "none";
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
  });
}

// ─── Code Copy Buttons ──────────────────────────────────────
function addCodeCopyButtons(container) {
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".code-header")) return;

    const code = pre.querySelector("code");
    if (!code) return;

    // Detect language from class
    const langMatch = code.className.match(/language-(\w+)/);
    const lang = langMatch ? langMatch[1] : "code";

    const header = document.createElement("div");
    header.className = "code-header";
    header.innerHTML = `
      <span class="code-lang">${escapeHtml(lang)}</span>
      <button class="copy-btn" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        Copy
      </button>
    `;

    pre.insertBefore(header, pre.firstChild);

    header.querySelector(".copy-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.classList.add("copied");
        btn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
          Copied!
        `;
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Copy
          `;
        }, 2000);
      } catch (_) {
        showToast("Failed to copy", "error");
      }
    });
  });
}

// ─── Upload ─────────────────────────────────────────────────

async function uploadFile(file) {
  if (!file || !file.name.toLowerCase().endsWith(".pdf")) {
    showToast("Only PDF files are supported", "error");
    return;
  }

  // Show loading state
  uploadStatus.textContent = `Processing ${file.name}…`;
  uploadStatus.className = "upload-status loading";
  uploadProgress.hidden = false;
  progressFill.style.width = "10%";

  const form = new FormData();
  form.append("file", file);

  // Fake progress animation
  let progress = 10;
  const progressInterval = setInterval(() => {
    progress = Math.min(progress + Math.random() * 8, 90);
    progressFill.style.width = `${progress}%`;
    progressText.textContent = `Indexing… ${Math.round(progress)}%`;
  }, 400);

  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Upload failed");
    }

    const data = await res.json();

    clearInterval(progressInterval);
    progressFill.style.width = "100%";
    progressText.textContent = `Indexed ${data.chunks} chunks from ${data.pages} pages`;

    uploadStatus.textContent = `${data.filename} — ${data.chunks} chunks indexed`;
    uploadStatus.className = "upload-status success";

    showToast(`${data.filename} uploaded successfully`, "success");
    loadDocuments();

    setTimeout(() => {
      uploadProgress.hidden = true;
      progressFill.style.width = "0%";
    }, 3000);
  } catch (err) {
    clearInterval(progressInterval);
    uploadStatus.textContent = err.message;
    uploadStatus.className = "upload-status error";
    uploadProgress.hidden = true;
    progressFill.style.width = "0%";
    showToast(err.message, "error");
  }

  // Auto-clear success/error after a while
  setTimeout(() => {
    if (uploadStatus.classList.contains("success") || uploadStatus.classList.contains("error")) {
      uploadStatus.textContent = "";
      uploadStatus.className = "upload-status";
    }
  }, 6000);
}

// ─── Document List ──────────────────────────────────────────

async function loadDocuments() {
  try {
    const res = await fetch("/api/documents");
    const data = await res.json();
    const docs = data.documents || [];

    docCount.textContent = docs.length;

    if (!docs.length) {
      docList.innerHTML = `
        <div class="doc-list-empty" id="emptyDocState">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <p>No documents yet</p>
          <span>Upload a PDF to get started</span>
        </div>`;
      return;
    }

    docList.innerHTML = docs
      .map(
        (d) => `
      <div class="doc-item" role="listitem">
        <div class="doc-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>
        <div class="doc-info">
          <div class="doc-name" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</div>
          <div class="doc-meta">${d.size}${d.builtin ? " · sample" : ""}</div>
        </div>
        ${
          d.builtin
            ? `<span class="doc-lock" title="Built-in document">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <rect x="3" y="11" width="18" height="11" rx="2"/>
                   <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                 </svg>
               </span>`
            : `<button class="doc-delete" data-name="${escapeHtml(d.name)}" aria-label="Delete ${escapeHtml(d.name)}" title="Delete document">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <polyline points="3 6 5 6 21 6"/>
                   <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                 </svg>
               </button>`
        }
      </div>`
      )
      .join("");

    // Attach delete handlers
    docList.querySelectorAll(".doc-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        pendingDelete = btn.dataset.name;
        deleteFilename.textContent = pendingDelete;
        deleteModal.showModal();
      });
    });
  } catch (err) {
    console.error("Failed to load documents:", err);
  }
}

// ─── Delete Modal ───────────────────────────────────────────
modalCancel.addEventListener("click", () => deleteModal.close());
modalClose.addEventListener("click", () => deleteModal.close());

modalConfirm.addEventListener("click", async () => {
  if (!pendingDelete) return;
  const name = pendingDelete;
  deleteModal.close();

  try {
    const res = await fetch(`/api/documents/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Delete failed");
    }
    showToast(`Deleted ${name}`, "success");
    loadDocuments();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    pendingDelete = null;
  }
});

deleteModal.addEventListener("close", () => {
  pendingDelete = null;
});

// ─── New Chat ───────────────────────────────────────────────
newChatBtn.addEventListener("click", () => {
  // Remove all messages
  messages.querySelectorAll(".message, .thinking").forEach((el) => el.remove());
  // Show empty state
  if (emptyState) emptyState.style.display = "";
  showToast("Chat cleared", "info");
});

// ─── Utilities ──────────────────────────────────────────────

function escapeHtml(str) {
  const el = document.createElement("div");
  el.textContent = str;
  return el.innerHTML;
}

function updateSendBtn() {
  const hasText = queryInput.value.trim().length > 0;
  sendBtn.disabled = !hasText && !isLoading;
}

// ─── Event Listeners ────────────────────────────────────────

// Auto-resize textarea
queryInput.addEventListener("input", () => {
  queryInput.style.height = "auto";
  queryInput.style.height = Math.min(queryInput.scrollHeight, 160) + "px";
  updateSendBtn();
});

// Enter to send, Shift+Enter for newline
queryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(queryInput.value);
  }
});

sendBtn.addEventListener("click", () => sendMessage(queryInput.value));

// Suggestion chips
document.querySelectorAll(".suggestion-chip").forEach((btn) => {
  btn.addEventListener("click", () => sendMessage(btn.dataset.q));
});

// File upload — click
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]);
  fileInput.value = "";
});

// File upload — drag & drop
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});
