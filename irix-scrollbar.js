/* =====================================================================
   irix-scrollbar.js — cross-browser IRIX scrollbar.
   Firefox has no ::-webkit-scrollbar, so we hide the native bar and draw
   our own: a recessed trough, a raised draggable thumb, and arrow
   steppers. Attaches to every .irix-scroll element and tracks size /
   content changes with a ResizeObserver (works with the window manager's
   live resizing) plus image-load and scroll listeners.
   ===================================================================== */
(function () {
  "use strict";

  const LINE = 48;         // px scrolled per stepper click
  const REPEAT_MS = 60;    // held-button repeat interval

  function build(el) {
    if (el.dataset.iscroll) return;
    // the bar overlays the element's right edge from a positioned ancestor
    const host = el.parentElement;
    if (!host) return;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    el.dataset.iscroll = "1";
    el.classList.add("has-iscroll");

    const bar = document.createElement("div");
    bar.className = "iscroll";
    bar.innerHTML =
      '<button class="iscroll-btn iscroll-up" type="button" tabindex="-1" aria-hidden="true"></button>' +
      '<div class="iscroll-track"><div class="iscroll-thumb"></div></div>' +
      '<button class="iscroll-btn iscroll-down" type="button" tabindex="-1" aria-hidden="true"></button>';
    host.appendChild(bar);

    const track = bar.querySelector(".iscroll-track");
    const thumb = bar.querySelector(".iscroll-thumb");
    const upBtn = bar.querySelector(".iscroll-up");
    const downBtn = bar.querySelector(".iscroll-down");

    // overlay the bar precisely over the element's inner right edge, so this
    // works whether el fills its parent (window body) or is nested (fe-view)
    function layout() {
      const hr = host.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      bar.style.top = (er.top - hr.top) + el.clientTop + "px";
      bar.style.left = (er.left - hr.left) + el.clientLeft + el.clientWidth - 20 + "px";
      bar.style.height = el.clientHeight + "px";
    }

    function update() {
      const ch = el.clientHeight;
      const sh = el.scrollHeight;
      if (!ch) return;                       // hidden window: skip
      const overflow = sh - ch;
      if (overflow <= 1) { bar.hidden = true; return; }
      bar.hidden = false;
      layout();
      const trackH = track.clientHeight;
      const thumbH = Math.max(24, Math.round(trackH * ch / sh));
      const maxThumb = trackH - thumbH;
      const top = overflow > 0 ? Math.round((el.scrollTop / overflow) * maxThumb) : 0;
      thumb.style.height = thumbH + "px";
      thumb.style.top = Math.max(0, Math.min(maxThumb, top)) + "px";
    }

    // --- thumb drag ---
    thumb.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const trackH = track.clientHeight;
      const thumbH = thumb.offsetHeight;
      const maxThumb = trackH - thumbH;
      const overflow = el.scrollHeight - el.clientHeight;
      const startY = e.clientY;
      const startTop = parseFloat(thumb.style.top) || 0;
      thumb.classList.add("dragging");
      thumb.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const t = Math.max(0, Math.min(maxThumb, startTop + (ev.clientY - startY)));
        el.scrollTop = maxThumb > 0 ? (t / maxThumb) * overflow : 0;
      };
      const up = (ev) => {
        thumb.classList.remove("dragging");
        thumb.releasePointerCapture(ev.pointerId);
        thumb.removeEventListener("pointermove", move);
        thumb.removeEventListener("pointerup", up);
        thumb.removeEventListener("pointercancel", up);
      };
      thumb.addEventListener("pointermove", move);
      thumb.addEventListener("pointerup", up);
      thumb.addEventListener("pointercancel", up);
    });

    // --- click in the trough pages toward the click ---
    track.addEventListener("pointerdown", (e) => {
      if (e.target === thumb) return;
      const r = track.getBoundingClientRect();
      const page = el.clientHeight * 0.9;
      el.scrollTop += (e.clientY - r.top < parseFloat(thumb.style.top || 0)) ? -page : page;
    });

    // --- steppers, with press-and-hold repeat ---
    function stepper(btn, dir) {
      let timer = null;
      const step = () => { el.scrollTop += dir * LINE; };
      btn.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        step();
        timer = setInterval(step, REPEAT_MS);
        btn.setPointerCapture(e.pointerId);
      });
      const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
      btn.addEventListener("pointerup", stop);
      btn.addEventListener("pointercancel", stop);
      btn.addEventListener("lostpointercapture", stop);
    }
    stepper(upBtn, -1);
    stepper(downBtn, 1);

    // --- keep in sync ---
    el.addEventListener("scroll", update, { passive: true });
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      ro.observe(host);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    el.querySelectorAll("img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", update, { once: true });
    });
    update();
    // re-measure after layout settles (fonts/images)
    requestAnimationFrame(update);
    setTimeout(update, 300);
  }

  function init() {
    document.querySelectorAll(".irix-scroll").forEach(build);
    // expose so newly created scroll areas can opt in later
    window.IrixScroll = { attach: build };
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
