// The reader page, shared by the one-off book_preview export and the live
// preview server so both render a chapter identically.

import { escapeHtml, markdownToHtml } from "../utils/markdown";

export interface ReaderPageOptions {
  /**
   * Reload the page every N seconds via a meta refresh. The live server sets
   * it; the one-off export leaves it off. A meta refresh rather than a script,
   * so a saved page carries no executable code.
   */
  refreshSeconds?: number;
  /** BCP 47 tag for the page, so the browser hyphenates in the book's language. */
  language?: string;
  /**
   * The live server's reader: instead of reloading on a timer, the page asks
   * /version whether the text has changed and only then updates, and lets the
   * reader mark passages for revision. The one-off export leaves it off, so a
   * saved page still carries no script.
   */
  live?: {
    pollSeconds: number;
    /** Fingerprint of the text this page shows. */
    version: string;
    openNotes: number;
  };
}

const LABELS = {
  en: {
    mark: "Mark for revision",
    title: "Mark for revision",
    placeholder: "What should change? (optional)",
    comment: "Comment",
    question: "Question",
    suggestion: "Revise",
    save: "Save",
    cancel: "Cancel",
    saved: "Marked.",
    failed: "Could not save the mark.",
    changed: "The text has changed.",
    reload: "Update now",
    auto: "Update automatically",
    openNotes: (n: number) => `${n} open ${n === 1 ? "note" : "notes"}`,
  },
  de: {
    mark: "Zur Überarbeitung markieren",
    title: "Zur Überarbeitung markieren",
    placeholder: "Was soll geändert werden? (optional)",
    comment: "Kommentar",
    question: "Frage",
    suggestion: "Überarbeiten",
    save: "Speichern",
    cancel: "Abbrechen",
    saved: "Markiert.",
    failed: "Markierung konnte nicht gespeichert werden.",
    changed: "Der Text hat sich geändert.",
    reload: "Jetzt aktualisieren",
    auto: "Automatisch aktualisieren",
    openNotes: (n: number) => `${n} offene ${n === 1 ? "Notiz" : "Notizen"}`,
  },
};

function labelsFor(language: string | undefined) {
  return /^de\b/i.test(language ?? "") ? LABELS.de : LABELS.en;
}

const LIVE_CSS = `
    .live-bar {
      position: fixed; left: 20px; bottom: 20px; display: none; gap: 10px;
      align-items: center; background: #2c2c2c; color: #f5f1eb;
      font: 12px system-ui, sans-serif; padding: 8px 14px; border-radius: 20px;
    }
    .live-bar.show { display: flex; }
    .live-bar button { font: inherit; color: #1a1a1a; background: #e8dcc2; border: 0; border-radius: 12px; padding: 3px 10px; cursor: pointer; }
    .live-auto { position: fixed; left: 20px; bottom: 60px; font: 11px system-ui, sans-serif; color: #888; }
    .mark-button {
      position: absolute; z-index: 20; display: none; background: #6b4c2a; color: #fff;
      font: 13px system-ui, sans-serif; border: 0; border-radius: 6px; padding: 8px 14px; touch-action: manipulation;
      cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.25);
    }
    .mark-dialog {
      position: fixed; inset: 0; z-index: 30; display: none; align-items: center;
      justify-content: center; background: rgba(0,0,0,0.35);
    }
    .mark-dialog.show { display: flex; }
    .mark-card {
      width: min(460px, 92vw); background: #fffdf8; border-radius: 10px; padding: 20px;
      font: 14px system-ui, sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    }
    .mark-card h2 { font: 700 16px system-ui, sans-serif; margin: 0 0 10px; letter-spacing: 0; }
    .mark-quote { font: italic 14px/1.5 'Source Serif 4', Georgia, serif; color: #555; border-left: 3px solid #c9b99a; padding-left: 10px; margin-bottom: 12px; max-height: 8em; overflow: auto; }
    .mark-card textarea { width: 100%; min-height: 80px; font: inherit; padding: 8px; border: 1px solid #d8d0c0; border-radius: 6px; resize: vertical; }
    .mark-row { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
    .mark-row select { font: inherit; padding: 5px; }
    .mark-row .spacer { flex: 1; }
    .mark-row button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #c9b99a; background: #fff; cursor: pointer; }
    .mark-row button.primary { background: #6b4c2a; border-color: #6b4c2a; color: #fff; }
    .mark-error { color: #a33; margin-top: 8px; min-height: 1em; }
    .mark-toast { position: fixed; bottom: 70px; right: 20px; background: #2c2c2c; color: #fff; padding: 8px 14px; border-radius: 6px; font: 13px system-ui, sans-serif; display: none; }
    .mark-toast.show { display: block; }
`;

function liveScript(live: NonNullable<ReaderPageOptions["live"]>, language?: string): string {
  const L = labelsFor(language);
  const config = JSON.stringify({
    poll: live.pollSeconds * 1000,
    version: live.version,
    openNotes: live.openNotes,
    labels: {
      mark: L.mark, title: L.title, placeholder: L.placeholder, comment: L.comment,
      question: L.question, suggestion: L.suggestion, save: L.save, cancel: L.cancel,
      saved: L.saved, failed: L.failed, changed: L.changed, reload: L.reload,
      auto: L.auto, noteOne: L.openNotes(1), noteMany: L.openNotes(2),
    },
  }).replace(/</g, "\\u003c");

  return `<script>
(function () {
  var cfg = ${config};
  var L = cfg.labels;
  var book = document.querySelector('.book');
  var countEl = document.getElementById('note-count');
  var KEY = 'preview-auto-update';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }

  // --- keep the reading position across an update -------------------------
  try {
    var y = sessionStorage.getItem('preview-scroll');
    if (y !== null) { sessionStorage.removeItem('preview-scroll'); window.scrollTo(0, Number(y)); }
  } catch (e) {}

  function setNotes(n) {
    cfg.openNotes = n;
    if (!countEl) return;
    countEl.textContent = n ? ' \\u00b7 ' + (n === 1 ? L.noteOne : L.noteMany.replace(/^2/, String(n))) : '';
  }
  setNotes(cfg.openNotes);

  // --- update only when the text changed ----------------------------------
  var bar = el('div', 'live-bar');
  var barText = el('span', '', L.changed);
  var barBtn = el('button', '', L.reload);
  bar.appendChild(barText); bar.appendChild(barBtn);
  var autoLabel = el('label', 'live-auto');
  var autoBox = document.createElement('input');
  autoBox.type = 'checkbox';
  autoBox.checked = store(KEY) !== 'off';
  autoBox.addEventListener('change', function () { store(KEY, autoBox.checked ? 'on' : 'off'); });
  autoLabel.appendChild(autoBox);
  autoLabel.appendChild(document.createTextNode(' ' + L.auto));
  document.body.appendChild(bar);
  document.body.appendChild(autoLabel);

  var changed = false;
  function reload() {
    try { sessionStorage.setItem('preview-scroll', String(window.scrollY)); } catch (e) {}
    location.reload();
  }
  barBtn.addEventListener('click', reload);

  var dialogOpen = false;
  function selecting() {
    var s = window.getSelection();
    return !!s && !s.isCollapsed && s.toString().trim() !== '';
  }
  function apply() {
    if (!changed) return;
    if (autoBox.checked && !dialogOpen && !selecting()) { reload(); return; }
    bar.classList.add('show');
  }
  function poll() {
    if (document.hidden) return;
    fetch('/version', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (typeof d.openNotes === 'number') setNotes(d.openNotes);
        if (d.version !== cfg.version) changed = true;
        apply();
      })
      .catch(function () {});
  }
  setInterval(poll, cfg.poll);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  // --- marking passages ----------------------------------------------------
  var button = el('button', 'mark-button', L.mark);
  button.type = 'button';
  var dialog = el('div', 'mark-dialog');
  var card = el('div', 'mark-card');
  var quoteEl = el('div', 'mark-quote');
  var area = document.createElement('textarea');
  area.placeholder = L.placeholder;
  var kind = document.createElement('select');
  [['suggestion', L.suggestion], ['comment', L.comment], ['question', L.question]].forEach(function (o) {
    var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1]; kind.appendChild(opt);
  });
  var cancel = el('button', '', L.cancel); cancel.type = 'button';
  var save = el('button', 'primary', L.save); save.type = 'button';
  var row = el('div', 'mark-row');
  row.appendChild(kind); row.appendChild(el('span', 'spacer')); row.appendChild(cancel); row.appendChild(save);
  var err = el('div', 'mark-error');
  card.appendChild(el('h2', '', L.title)); card.appendChild(quoteEl); card.appendChild(area);
  card.appendChild(row); card.appendChild(err);
  dialog.appendChild(card);
  var toast = el('div', 'mark-toast');
  document.body.appendChild(button); document.body.appendChild(dialog); document.body.appendChild(toast);

  var pending = null;
  function flash(msg) {
    toast.textContent = msg; toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 2200);
  }
  function current() {
    var s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    var range = s.getRangeAt(0);
    if (!book.contains(range.commonAncestorContainer)) return null;
    var text = s.toString();
    if (text.trim().length < 2) return null;
    var node = range.startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    var block = node.closest ? node.closest('p, blockquote, h1, h2, h3') : null;
    return { selection: text, container: block ? block.textContent : '', rect: range.getBoundingClientRect() };
  }
  function place() {
    var cur = current();
    if (!cur || dialogOpen) { button.style.display = 'none'; return; }
    button.style.display = 'block';
    // On touch screens the system's copy menu sits above the selection, so the
    // button goes below it.
    var touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    button.style.top = (window.scrollY + (touch ? cur.rect.bottom + 14 : cur.rect.top - 40)) + 'px';
    button.style.left = Math.max(8, window.scrollX + cur.rect.left) + 'px';
  }
  document.addEventListener('mouseup', function () { setTimeout(place, 0); });
  document.addEventListener('keyup', function () { setTimeout(place, 0); });
  // Touch selections are made and adjusted with handles that fire no mouse or
  // key events, only selectionchange — which also fires while a handle is
  // dragged, so wait until it settles.
  var settle = null;
  document.addEventListener('selectionchange', function () {
    if (!selecting()) { button.style.display = 'none'; return; }
    clearTimeout(settle);
    settle = setTimeout(place, 350);
  });
  // mousedown would collapse the selection before the click lands.
  button.addEventListener('mousedown', function (e) { e.preventDefault(); });
  button.addEventListener('click', function () {
    pending = current();
    if (!pending) return;
    quoteEl.textContent = pending.selection.replace(/\\s+/g, ' ').trim();
    area.value = ''; err.textContent = '';
    dialogOpen = true; dialog.classList.add('show'); button.style.display = 'none';
    area.focus();
  });
  function close() { dialogOpen = false; dialog.classList.remove('show'); pending = null; apply(); }
  cancel.addEventListener('click', close);
  dialog.addEventListener('mousedown', function (e) { if (e.target === dialog) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialogOpen) close(); });
  save.addEventListener('click', function () {
    if (!pending) return;
    save.disabled = true;
    fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection: pending.selection, container: pending.container, text: area.value, kind: kind.value })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        save.disabled = false;
        if (!res.ok) { err.textContent = (res.d && res.d.error) || L.failed; return; }
        setNotes(cfg.openNotes + 1);
        window.getSelection().removeAllRanges();
        close(); flash(L.saved);
      })
      .catch(function () { save.disabled = false; err.textContent = L.failed; });
  });
})();
</script>`;
}

export function buildReaderPage(
  title: string,
  author: string,
  content: string,
  wordCount: number,
  options: ReaderPageOptions = {}
): string {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(options.language ?? "en")}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Preview</title>
  ${
    options.refreshSeconds
      ? `<meta http-equiv="refresh" content="${options.refreshSeconds}" />`
      : ""
  }
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Serif+4:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: #f5f1eb;
      color: #2c2c2c;
      font-family: 'Source Serif 4', 'Georgia', serif;
      font-size: 18px;
      line-height: 1.8;
      -webkit-font-smoothing: antialiased;
    }

    .book {
      max-width: 640px;
      margin: 0 auto;
      padding: 60px 40px 120px;
      background: #fffdf8;
      min-height: 100vh;
      box-shadow: 0 0 60px rgba(0,0,0,0.08);
    }

    h1 {
      font-family: 'Playfair Display', 'Georgia', serif;
      font-size: 2em;
      font-weight: 700;
      margin: 2em 0 0.6em;
      line-height: 1.25;
      color: #1a1a1a;
      letter-spacing: -0.01em;
    }

    h1:first-child {
      font-size: 2.4em;
      margin-top: 1em;
      text-align: center;
      border-bottom: 2px solid #c9b99a;
      padding-bottom: 0.5em;
      margin-bottom: 1em;
    }

    h2 {
      font-family: 'Playfair Display', 'Georgia', serif;
      font-size: 1.4em;
      font-weight: 700;
      margin: 2.5em 0 0.8em;
      color: #1a1a1a;
      letter-spacing: 0.02em;
    }

    h3 {
      font-family: 'Playfair Display', 'Georgia', serif;
      font-size: 1.15em;
      font-weight: 700;
      margin: 2em 0 0.6em;
      color: #333;
    }

    p {
      margin-bottom: 1.2em;
      text-align: justify;
      hyphens: auto;
    }

    /* Drop cap on the first paragraph after each chapter heading */
    h1 + p::first-letter,
    h2 + p::first-letter {
      font-family: 'Playfair Display', serif;
      font-size: 3.2em;
      float: left;
      line-height: 0.8;
      margin: 0.05em 0.1em 0 0;
      color: #6b4c2a;
    }

    blockquote {
      margin: 1.5em 2em;
      font-style: italic;
      color: #4a4a4a;
    }
    blockquote em { font-style: normal; }

    em { font-style: italic; }
    strong { font-weight: 600; }

    hr {
      border: none;
      text-align: center;
      margin: 2.5em 0;
    }
    hr::after {
      content: '\\2022  \\2022  \\2022';
      color: #c9b99a;
      font-size: 1.2em;
      letter-spacing: 0.5em;
    }

    .timestamp {
      text-align: center;
      color: #999;
      font-size: 0.75em;
      font-family: system-ui, sans-serif;
      padding: 20px 0;
      border-top: 1px solid #e8e2d8;
      margin-top: 60px;
    }

    .word-count {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #2c2c2c;
      color: #f5f1eb;
      font-family: system-ui, sans-serif;
      font-size: 12px;
      padding: 8px 14px;
      border-radius: 20px;
      opacity: 0.7;
    }

    @media (max-width: 700px) {
      .book { padding: 40px 24px 100px; }
      body { font-size: 16px; }
      h1:first-child { font-size: 1.8em; }
    }
    ${options.live ? LIVE_CSS : ""}
  </style>
</head>
<body>
  <div class="book">
    ${content}
    <div class="timestamp">Generated: ${new Date().toLocaleString()}</div>
  </div>
  <div class="word-count">${wordCount.toLocaleString()} words<span id="note-count"></span></div>
  ${options.live ? liveScript(options.live, options.language) : ""}
</body>
</html>`;
}
