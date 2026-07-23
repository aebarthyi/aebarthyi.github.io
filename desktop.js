/* =====================================================================
   desktop.js — a small IRIX-flavoured window manager
   No dependencies. Drives every .window inside #desktop:
   drag, edge/corner resize, minimize/maximize/close, z-order focus,
   a taskbar, and a FLIP "grow from the launcher" open animation.
   ===================================================================== */
(function () {
  "use strict";

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MIN_W = 240, MIN_H = 150;

  const desktop = document.getElementById("desktop");
  const taskbar = document.getElementById("taskbar");
  const state = new Map();          // id -> window state
  let zTop = 20;
  let activeId = null;
  let spawnStagger = 0;

  const deskRect = () => desktop.getBoundingClientRect();

  /* ---- geometry helpers ---------------------------------------------- */
  function setRect(el, r) {
    if (r.left   != null) el.style.left   = r.left   + "px";
    if (r.top    != null) el.style.top    = r.top    + "px";
    if (r.width  != null) el.style.width  = r.width  + "px";
    if (r.height != null) el.style.height = r.height + "px";
  }
  function getRect(el) {
    const d = deskRect(), b = el.getBoundingClientRect();
    return { left: b.left - d.left, top: b.top - d.top, width: b.width, height: b.height };
  }
  function clampIntoDesktop(el) {
    const d = deskRect();
    const w = el.offsetWidth, th = 40;
    let left = parseFloat(el.style.left) || 0;
    let top  = parseFloat(el.style.top)  || 0;
    left = Math.min(Math.max(left, 40 - w), d.width - 40);
    top  = Math.min(Math.max(top, 0), d.height - th);
    el.style.left = left + "px";
    el.style.top  = top + "px";
  }

  /* ---- focus / z-order ----------------------------------------------- */
  function raise(el) { el.style.zIndex = ++zTop; }
  function setActive(id) {
    activeId = id;
    for (const [wid, s] of state) {
      const on = wid === id && !s.min;
      s.el.classList.toggle("is-active", on);
      if (s.tbBtn) s.tbBtn.classList.toggle("is-active", on);
    }
  }
  function focusWindow(s) { raise(s.el); setActive(s.id); }

  /* ---- placement ----------------------------------------------------- */
  function centerPlace(s) {
    const d = deskRect();
    const w = s.el.offsetWidth, h = s.el.offsetHeight;
    const left = Math.max(8, (d.width  - w) / 2) + spawnStagger;
    const top  = Math.max(8, (d.height - h) / 2 - 20) + spawnStagger;
    setRect(s.el, { left, top });
    spawnStagger = (spawnStagger + 28) % 140;
    s.placed = true;
  }

  /* ---- open / close / minimize / maximize ---------------------------- */
  function present(s) { return !s.el.hidden; }

  function open(s, sourceEl) {
    const firstOpen = s.el.hidden;
    s.el.hidden = false;
    s.min = false;
    if (!s.placed) centerPlace(s);
    focusWindow(s);
    syncTaskbar();
    if (firstOpen && sourceEl) flipFrom(s.el, sourceEl, true);
  }

  function close(s) {
    if (s.el.hidden) return;
    const btn = s.tbBtn;
    const done = () => { s.el.hidden = true; s.min = false; syncTaskbar(); focusTopmost(); };
    if (btn) flipTo(s.el, btn, done); else done();
  }

  function minimize(s) {
    if (s.el.hidden || s.min) return;
    const btn = s.tbBtn;
    const finish = () => { s.el.hidden = true; s.min = true; syncTaskbar(); focusTopmost(); };
    if (btn) flipTo(s.el, btn, finish); else finish();
  }

  function restore(s) {
    s.el.hidden = false;
    s.min = false;
    focusWindow(s);
    syncTaskbar();
    if (s.tbBtn) flipFrom(s.el, s.tbBtn, true);
  }

  function toggleMax(s) {
    if (s.el.classList.contains("is-max")) {
      s.el.classList.remove("is-max");
      if (s.prevRect) setRect(s.el, s.prevRect);
    } else {
      s.prevRect = getRect(s.el);
      const d = deskRect();
      s.el.classList.add("is-max");
      setRect(s.el, { left: 0, top: 0, width: d.width, height: d.height });
    }
    focusWindow(s);
  }

  function focusTopmost() {
    let top = null, topZ = -1;
    for (const [, s] of state) {
      if (present(s) && !s.min) {
        const z = parseInt(s.el.style.zIndex || 0, 10);
        if (z >= topZ) { topZ = z; top = s; }
      }
    }
    if (top) setActive(top.id); else setActive(null);
  }

  /* ---- FLIP animations ----------------------------------------------- */
  function flipFrom(el, sourceEl, opening) {
    if (reduce) return;
    const src = sourceEl.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const dx = src.left - box.left, dy = src.top - box.top;
    const sx = Math.max(src.width / box.width, .05);
    const sy = Math.max(src.height / box.height, .05);
    el.style.transformOrigin = "top left";
    const collapsed = { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.2 };
    const rest = { transform: "none", opacity: 1 };
    el.animate(opening ? [collapsed, rest] : [rest, collapsed], {
      duration: 300, easing: "cubic-bezier(.2,.8,.2,1)", fill: "none",
    });
  }
  function flipTo(el, targetEl, done) {
    if (reduce) { done(); return; }
    const dst = targetEl.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) { done(); return; }
    const dx = dst.left - box.left, dy = dst.top - box.top;
    const sx = Math.max(dst.width / box.width, .05);
    const sy = Math.max(dst.height / box.height, .05);
    el.style.transformOrigin = "top left";
    const a = el.animate([
      { transform: "none", opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.15 },
    ], { duration: 240, easing: "cubic-bezier(.4,0,.7,.2)", fill: "none" });
    a.finished.then(done).catch(done);
  }

  /* ---- dragging ------------------------------------------------------ */
  function makeDraggable(s) {
    const handle = s.el.querySelector(".titlebar");
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".wb, [role='button'], a")) return;   // let controls click
      if (s.el.classList.contains("is-max")) return;             // don't drag maximized
      const startX = e.clientX, startY = e.clientY;
      const baseL = parseFloat(s.el.style.left) || 0;
      const baseT = parseFloat(s.el.style.top)  || 0;
      focusWindow(s);
      s.el.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        s.el.style.left = baseL + (ev.clientX - startX) + "px";
        s.el.style.top  = baseT + (ev.clientY - startY) + "px";
      };
      const up = (ev) => {
        s.el.classList.remove("dragging");
        clampIntoDesktop(s.el);
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    // double-click titlebar toggles maximize
    handle.addEventListener("dblclick", (e) => {
      if (e.target.closest(".wb, [role='button'], a")) return;
      toggleMax(s);
    });
  }

  /* ---- resizing ------------------------------------------------------ */
  const DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
  function makeResizable(s) {
    const frame = s.el;   // handles are appended to the window element
    for (const dir of DIRS) {
      const h = document.createElement("div");
      h.className = "rz rz-" + dir;
      frame.appendChild(h);
      h.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || s.el.classList.contains("is-max")) return;
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        const r0 = getRect(s.el);
        focusWindow(s);
        s.el.classList.add("resizing");
        h.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const dx = ev.clientX - startX, dy = ev.clientY - startY;
          let { left, top, width, height } = r0;
          if (dir.includes("e")) width  = Math.max(MIN_W, r0.width + dx);
          if (dir.includes("s")) height = Math.max(MIN_H, r0.height + dy);
          if (dir.includes("w")) {
            const nw = Math.max(MIN_W, r0.width - dx);
            left = r0.left + (r0.width - nw); width = nw;
          }
          if (dir.includes("n")) {
            const nh = Math.max(MIN_H, r0.height - dy);
            top = r0.top + (r0.height - nh); height = nh;
          }
          setRect(s.el, { left, top, width, height });
        };
        const up = (ev) => {
          s.el.classList.remove("resizing");
          h.releasePointerCapture(ev.pointerId);
          h.removeEventListener("pointermove", move);
          h.removeEventListener("pointerup", up);
          h.removeEventListener("pointercancel", up);
        };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
        h.addEventListener("pointercancel", up);
      });
    }
  }

  /* ---- window controls ----------------------------------------------- */
  function wireControls(s) {
    const closeBtn = s.el.querySelector(".wb-menu");
    const minBtn   = s.el.querySelector(".wb-iconify");
    const maxBtn   = s.el.querySelector(".wb-max");
    if (closeBtn) {
      if (s.closable === false) { closeBtn.setAttribute("data-disabled", ""); }
      else closeBtn.addEventListener("click", () => close(s));
    }
    if (minBtn) minBtn.addEventListener("click", () => minimize(s));
    if (maxBtn) maxBtn.addEventListener("click", () => toggleMax(s));
    // clicking anywhere in the window focuses it
    s.el.addEventListener("pointerdown", () => focusWindow(s), true);
  }

  /* ---- taskbar ------------------------------------------------------- */
  function syncTaskbar() {
    for (const [, s] of state) {
      const shown = present(s) || s.min;
      if (shown && !s.tbBtn) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.innerHTML = '<span class="tb-label"></span>';
        btn.querySelector(".tb-label").textContent = s.label;
        btn.title = s.label;
        btn.addEventListener("click", () => {
          if (s.min) return restore(s);
          if (activeId === s.id && present(s)) return minimize(s);
          focusWindow(s);
        });
        s.tbBtn = btn;
        clock ? taskbar.insertBefore(btn, clock) : taskbar.appendChild(btn);
      } else if (!shown && s.tbBtn) {
        s.tbBtn.remove();
        s.tbBtn = null;
      }
      if (s.tbBtn) {
        s.tbBtn.classList.toggle("is-min", !!s.min);
        s.tbBtn.classList.toggle("is-active", activeId === s.id && !s.min);
      }
    }
  }

  /* ---- clock --------------------------------------------------------- */
  let clock = null;
  function startClock() {
    clock = document.createElement("span");
    clock.className = "tb-clock";
    taskbar.appendChild(clock);
    const tick = () => {
      const d = new Date();
      const h = d.getHours(), m = d.getMinutes();
      clock.textContent =
        String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
    };
    tick();
    setInterval(tick, 15000);
  }

  /* ---- desktop icons: select on click, launch on double-click/Enter -- */
  function initDeskIcons() {
    const icons = Array.from(document.querySelectorAll(".desk-icon"));
    const deselect = () => icons.forEach((i) => i.classList.remove("is-selected"));
    const select = (icon) => { deselect(); icon.classList.add("is-selected"); };
    const launch = (icon) => {
      if (icon.dataset.open) {
        const s = state.get(icon.dataset.open);
        if (s) open(s, icon);
      } else if (icon.dataset.href) {
        window.open(icon.dataset.href, "_blank", "noopener");
      }
    };
    icons.forEach((icon) => {
      icon.addEventListener("click", () => select(icon));
      icon.addEventListener("dblclick", (e) => { e.preventDefault(); launch(icon); });
      icon.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(icon); launch(icon); }
      });
    });
    // clicking empty desktop clears the selection
    desktop.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".desk-icon")) deselect();
    });
  }

  /* ---- init ---------------------------------------------------------- */
  function register(el) {
    const id = el.id;
    const s = {
      id, el,
      label: el.dataset.label || el.querySelector(".title")?.textContent || id,
      closable: el.dataset.closable !== "false",
      min: false, placed: false, prevRect: null, tbBtn: null,
    };
    state.set(id, s);
    wireControls(s);
    makeDraggable(s);
    makeResizable(s);
    return s;
  }

  function init() {
    startClock();
    const wins = desktop.querySelectorAll(".window");
    wins.forEach(register);

    // place + show any window that isn't hidden at load
    for (const [, s] of state) {
      if (!s.el.hidden) { if (!s.placed) centerPlace(s); }
    }
    syncTaskbar();
    focusTopmost();

    // single-click launchers (home-window nav links, not desktop icons)
    document.querySelectorAll("[data-open]:not(.desk-icon)").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const s = state.get(btn.dataset.open);
        if (s) open(s, btn);
      });
    });

    initDeskIcons();

    // Escape closes/minimizes the active window (if closable)
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !activeId) return;
      const s = state.get(activeId);
      if (!s || s.el.hidden) return;
      s.closable ? close(s) : minimize(s);
    });

    // keep maximized windows filling the desktop on resize
    let rt;
    window.addEventListener("resize", () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        const d = deskRect();
        for (const [, s] of state) {
          if (s.el.classList.contains("is-max"))
            setRect(s.el, { left: 0, top: 0, width: d.width, height: d.height });
          else if (present(s)) clampIntoDesktop(s.el);
        }
      }, 120);
    });
  }

  // expose a tiny API in case other scripts want to open windows
  window.Desktop = { open: (id, src) => { const s = state.get(id); if (s) open(s, src); } };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
