/**
 * Zorrito V2 — Shared nav header injector + i18n bridge.
 *
 * Drops a consistent <header> into every page (docs/stats/agent/build/index).
 * Each page should have a <div id="zv2-header"></div> placeholder where the
 * existing <header>...</header> used to be (or this script will look for an
 * existing <header> and replace it).
 *
 * Also wires the language picker. Languages: EN / ES / PT.
 * If lang.js (window.ZORRITO_T) is loaded, picking a language re-renders all
 * elements that carry data-i18n / data-i18n-html / data-i18n-placeholder.
 *
 * Usage:
 *   <script src="lang.js"></script>           <!-- optional, only needed for translations -->
 *   <script src="nav-shared.js"></script>     <!-- always -->
 *   Add: data-zv2-page="docs"  (or stats/agent/build) on <body>
 *        Or pass via data-active-page on the script tag.
 */

(function () {
  const PAGES = [
    { key: "stats", href: "stats.html", label: "📊 Stats" },
    { key: "docs",  href: "docs.html",  label: "📄 Docs"  },
    { key: "agent", href: "agent.html", label: "🤖 Agent" },
    { key: "build", href: "build.html", label: "🛠️ Build" },
  ];

  // Auto-detect current page from <body data-zv2-page="..."> or from URL.
  function activePageKey() {
    const fromBody = document.body?.dataset?.zv2Page;
    if (fromBody) return fromBody;
    const path = (location.pathname.split("/").pop() || "index.html").toLowerCase();
    if (path === "" || path === "index.html") return "home";
    const m = path.match(/^([a-z-]+)\.html$/);
    return m ? m[1] : "home";
  }

  function buildHeader(active) {
    const isHome = active === "home";

    // On home, keep nav clean — only the Connect button + lang picker show.
    // Other pages get full nav (other subpages) + the "← App" return link.
    const navLinksHtml = isHome
      ? ""
      : PAGES
          .filter(p => p.key !== active)
          .map(p => `<a href="${p.href}" class="zv2-nav-link">${p.label}</a>`)
          .join("");

    const homeReturn = isHome
      ? ""
      : `<a href="index.html" class="zv2-nav-link zv2-nav-link-app">← App</a>`;

    const connectBtn = isHome
      ? `<button id="btn-connect">
           <svg id="btn-connect-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--orange)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
             <rect x="2" y="5" width="20" height="14" rx="3"/><path d="M16 12h.01"/><path d="M2 10h20"/>
           </svg>
           <span id="btn-connect-label" data-i18n="connect-wallet">Conectar Wallet</span>
         </button>`
      : "";

    const minipayBadge = isHome
      ? `<span id="minipay-badge" class="minipay-badge-inline">
           <svg style="flex-shrink:0;" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
           <span style="flex-shrink:0;font-size:0.75rem;font-weight:700;color:var(--green);">MiniPay</span>
           <span id="minipay-addr" style="font-size:0.75rem;color:var(--muted);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;"></span>
         </span>`
      : "";

    return `
      <header class="zv2-header">
        <div class="logo">
          <span>Zorr<span>ito</span> <span style="font-size:0.65em;opacity:0.8;">V2</span></span>
        </div>
        <div class="zv2-header-right">
          <div class="lang-picker" id="lang-picker">
            <button class="lang-btn" type="button" id="lang-btn-trigger">
              <span id="lang-label">🌐 ES</span>
              <svg class="lang-chevron" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <div class="lang-menu" id="lang-menu">
              <button type="button" data-lang="en">🌐 EN</button>
              <button type="button" data-lang="es">🌐 ES</button>
              <button type="button" data-lang="pt">🌐 PT</button>
            </div>
          </div>
          <div class="nav-links">${navLinksHtml}${homeReturn}</div>
          ${minipayBadge}
          ${connectBtn}
        </div>
      </header>
    `;
  }

  function injectStyles() {
    if (document.getElementById("zv2-nav-styles")) return;
    const s = document.createElement("style");
    s.id = "zv2-nav-styles";
    s.textContent = `
      .zv2-header { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .zv2-header-right { display:flex; align-items:center; gap:8px; margin-left:auto; flex-wrap:wrap; }
      /* On home in mobile, hide the redundant "Zorrito V2" text — the big hero
         logo is already on top, no need to repeat the brand in the navbar. */
      @media (max-width: 640px) {
        body[data-zv2-page="home"] .zv2-header .logo { display:none; }
      }
      .zv2-nav-link {
        font-size:0.8rem; color:var(--muted); text-decoration:none;
        padding:6px 10px; border:1px solid var(--border); border-radius:8px;
        font-weight:600; white-space:nowrap;
      }
      .zv2-nav-link:hover { color:var(--orange); border-color:var(--orange); }
      .zv2-nav-link-app  { color:var(--green); border-color:rgba(26,153,96,0.3); font-weight:700; padding:6px 12px; }
      @media (max-width: 640px) {
        .zv2-header .nav-links { display:none; }    /* hide secondary nav on phones */
        .zv2-header .header-tagline { display:none; }
      }
    `;
    document.head.appendChild(s);
  }

  // ── i18n bridge ────────────────────────────────────────────────────────────
  const LS_LANG = "zorrito-lang";
  function getLang() {
    try {
      const stored = localStorage.getItem(LS_LANG);
      if (stored && ["en","es","pt"].includes(stored)) return stored;
    } catch {}
    return "es";
  }
  function setLang(lang) {
    try { localStorage.setItem(LS_LANG, lang); } catch {}
    applyTranslations(lang);
    updateLangLabel(lang);
    // Notify the app so dynamic JS-rendered strings (welcome bonus, fox bubble,
    // save button labels, toasts) can re-render in the chosen language.
    try { window.dispatchEvent(new CustomEvent("zorrito-lang-change", { detail: { lang } })); } catch {}
  }
  function updateLangLabel(lang) {
    const el = document.getElementById("lang-label");
    if (el) el.textContent = "🌐 " + lang.toUpperCase();
  }
  function applyTranslations(lang) {
    const T = window.ZORRITO_T;
    if (!T || !T[lang]) return;
    const dict = T[lang];
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const k = el.getAttribute("data-i18n");
      if (k && dict[k] != null) el.textContent = dict[k];
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const k = el.getAttribute("data-i18n-html");
      if (k && dict[k] != null) el.innerHTML = dict[k];
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const k = el.getAttribute("data-i18n-placeholder");
      if (k && dict[k] != null) el.setAttribute("placeholder", dict[k]);
    });
    document.documentElement.lang = lang;
  }

  function wireLangPicker() {
    const trigger = document.getElementById("lang-btn-trigger");
    const menu    = document.getElementById("lang-menu");
    if (!trigger || !menu) return;
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("open");
    });
    menu.querySelectorAll("button[data-lang]").forEach((b) => {
      b.addEventListener("click", () => {
        const lang = b.getAttribute("data-lang");
        setLang(lang);
        menu.classList.remove("open");
      });
    });
    document.addEventListener("click", () => menu.classList.remove("open"));
  }

  // ── Mount ──────────────────────────────────────────────────────────────────
  function mount() {
    injectStyles();
    const active = activePageKey();
    // Tag the body so CSS can target per-page (e.g. hide brand text on home/mobile)
    if (document.body && !document.body.dataset.zv2Page) {
      document.body.dataset.zv2Page = active;
    }
    const html = buildHeader(active);

    // 1) Use placeholder div if present
    const ph = document.getElementById("zv2-header");
    if (ph) { ph.outerHTML = html; }
    else {
      // 2) Else replace existing <header>
      const existing = document.querySelector("header");
      if (existing) { existing.outerHTML = html; }
      else {
        // 3) Else inject at top of <body>
        document.body.insertAdjacentHTML("afterbegin", html);
      }
    }

    wireLangPicker();
    const lang = getLang();
    updateLangLabel(lang);
    applyTranslations(lang);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  // Expose for app.js to apply translations after dynamic content changes.
  window.ZorritoNav = {
    applyTranslations: () => applyTranslations(getLang()),
    getLang,
    setLang,
  };
})();
