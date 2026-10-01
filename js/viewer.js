/* The Keppler Rooms — image viewer
 * Pan/zoom camera over a large chromolithograph with two resolution tiers
 * (mid JPEG loads instantly, full WebP/JPEG fades in when zoomed).
 * Camera state is normalized: {x, y} = image point at viewport center (0..1),
 * scale = zoom relative to whole-image "contain" fit (1.0 = full view).
 */
(function () {
  'use strict';

  const MIN_SCALE = 1.0;
  const MAX_SCALE = 5.5;

  class Viewer {
    constructor(container) {
      this.container = container;
      this.el = document.createElement('div');
      this.el.className = 'viewer-frame';
      // Focusable so the picture is reachable and operable from the keyboard:
      // arrows pan, +/- zoom, 0 returns to the whole sheet. Without this the
      // artwork is pointer-only, and ←/→ are spoken for by beat navigation.
      this.el.tabIndex = 0;
      this.el.setAttribute('role', 'group');
      this.el.innerHTML =
        '<img class="v-tier v-lqip" alt="" draggable="false">' +
        '<img class="v-tier v-mid" draggable="false">' +
        '<img class="v-tier v-full" alt="" draggable="false">';
      container.appendChild(this.el);
      this.lqip = this.el.querySelector('.v-lqip');
      this.mid = this.el.querySelector('.v-mid');
      this.full = this.el.querySelector('.v-full');
      // alt lives on the mid tier only: it is always present, and it is the
      // one image a screen reader should announce. The blur and the hi-res
      // layer are the same picture, so they stay silent duplicates.
      this.mid.alt = '';

      this.aspect = 1.5;           // w/h of current image
      this.cam = { x: 0.5, y: 0.5, scale: 1 };
      this._raf = null;
      this._glide = null;
      this._fullLoaded = false;
      this._fullRequested = false;
      this._pointers = new Map();
      this._pinch = null;
      this.onUserInteract = null;

      this._bind();
    }

    setImage(paths, aspect, altText) {
      this._fullLoaded = false;
      this._fullRequested = false;
      this.full.classList.remove('is-on');
      this.full.removeAttribute('src');
      this.lqip.src = paths.lqip || '';
      this.mid.src = paths.mid;
      this.mid.alt = altText || '';
      this.aspect = aspect || 1.5;
      this.cam = { x: 0.5, y: 0.5, scale: 1 };
      this.apply();
    }

    requestFull(paths) {
      if (this._fullRequested) return;
      this._fullRequested = true;
      const done = () => {
        this._fullLoaded = true;
        this.full.classList.add('is-on');
      };
      this.full.onload = done;
      // Try the WebP, then the JPEG, then stop and keep the 1600px mid tier.
      // The earlier guard compared `this.full.src` (resolved to an absolute
      // URL) against a relative path, so it never matched and a missing file
      // re-requested itself in a tight loop — hundreds of 404s a second.
      // A plain counter bounds it: two candidates, two failures, then quiet.
      const candidates = [paths.webp, paths.full].filter(Boolean);
      let tier = 0;
      this.full.onerror = () => {
        if (tier >= candidates.length) {
          this._fullLoaded = false;
          this.full.removeAttribute('src');
          return;
        }
        this.full.src = candidates[tier++];
      };
      if (!candidates.length) return;
      this.full.src = candidates[0];
      tier = 1;
    }

    /* ---------- camera ---------- */

    fitScale() {
      const vw = this.el.clientWidth, vh = this.el.clientHeight;
      const s = Math.min(vw / this.aspect, vh); // image displayed h = min(vh, vw/aspect); w = h*aspect
      return { w: s * this.aspect, h: s };
    }

    clampCam(c) {
      const { w, h } = this.fitScale();
      const vw = this.el.clientWidth, vh = this.el.clientHeight;
      c.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, c.scale));
      // shown image size at this scale
      const W = w * c.scale, H = h * c.scale;
      const marginX = Math.max(0, (vw / 2) / W);
      const marginY = Math.max(0, (vh / 2) / H);
      c.x = Math.min(1 - marginX, Math.max(marginX, c.x));
      c.y = Math.min(1 - marginY, Math.max(marginY, c.y));
      if (marginX >= 0.5) c.x = 0.5;
      if (marginY >= 0.5) c.y = 0.5;
      return c;
    }

    apply() {
      const { w } = this.fitScale();
      const W = w * this.cam.scale;
      const H = W / this.aspect;
      const vw = this.el.clientWidth, vh = this.el.clientHeight;
      const left = vw / 2 - this.cam.x * W;
      const top = vh / 2 - this.cam.y * H;
      const t = `translate(${left.toFixed(2)}px, ${top.toFixed(2)}px)`;
      const width = W.toFixed(2) + 'px';
      const height = H.toFixed(2) + 'px';
      for (const img of [this.lqip, this.mid, this.full]) {
        img.style.width = width;
        img.style.height = height;
        img.style.transform = t;
      }
      if (this.cam.scale > 1.04 && this._fullLoaded === false) {
        this.onNeedFull && this.onNeedFull();
      }
    }

    glideTo(target, dur) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (this._raf) cancelAnimationFrame(this._raf);
      if (!dur || reduce || dur < 60) {
        this.cam = this.clampCam({ ...target });
        this.apply();
        return;
      }
      const from = { ...this.cam };
      const t0 = performance.now();
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      const step = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        const k = ease(t);
        this.cam = this.clampCam({
          x: from.x + (target.x - from.x) * k,
          y: from.y + (target.y - from.y) * k,
          scale: from.scale + (target.scale - from.scale) * k,
        });
        this.apply();
        if (t < 1) this._raf = requestAnimationFrame(step);
        else this._raf = null;
      };
      this._raf = requestAnimationFrame(step);
    }

    /* ---------- input ---------- */

    _interrupt() {
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      if (this.onUserInteract) this.onUserInteract();
    }

    _bind() {
      const el = this.el;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        el.setPointerCapture(e.pointerId);
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this._interrupt();
        if (this._pointers.size === 2) {
          const pts = [...this._pointers.values()];
          this._pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), scale: this.cam.scale };
        }
      });
      el.addEventListener('pointermove', (e) => {
        if (!this._pointers.has(e.pointerId)) return;
        const prev = this._pointers.get(e.pointerId);
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this._pointers.size === 2 && this._pinch) {
          const pts = [...this._pointers.values()];
          const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          this.cam.scale = this._pinch.scale * (d / this._pinch.d);
          this.clampCam(this.cam); this.apply();
          return;
        }
        const { w } = this.fitScale();
        const W = w * this.cam.scale;
        const H = W / this.aspect;
        this.cam.x -= (e.clientX - prev.x) / W;
        this.cam.y -= (e.clientY - prev.y) / H;
        this.clampCam(this.cam);
        this.apply();
      });
      const release = (e) => {
        this._pointers.delete(e.pointerId);
        if (this._pointers.size < 2) this._pinch = null;
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);

      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        this._interrupt();
        const dir = e.deltaY < 0 ? 1 : -1;
        this.zoomAt(e.clientX, e.clientY, dir * 1.0016 ** Math.min(400, Math.abs(e.deltaY * 8)));
      }, { passive: false });

      el.addEventListener('dblclick', (e) => {
        this._interrupt();
        const target = this.cam.scale > 1.6 ? { x: 0.5, y: 0.5, scale: 1 } : null;
        if (target) { this.glideTo(target, 650); return; }
        this.zoomAt(e.clientX, e.clientY, 1.9, true);
      });

      // Keyboard accessibility for pan/zoom. stopPropagation matters: the app
      // binds Left/Right to beat navigation on the document, and +/-/0 here,
      // so without it a single keypress would both pan the picture and skip
      // the beat.
      el.addEventListener('keydown', (e) => {
        const pan = 0.08;
        const keys = ['+', '=', '-', '0', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
        if (!keys.includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        this._interrupt();
        switch (e.key) {
          case '+':
          case '=':
            this.zoomAt(el.clientWidth / 2, el.clientHeight / 2, 1.15, true);
            break;
          case '-':
            this.zoomAt(el.clientWidth / 2, el.clientHeight / 2, 0.87, true);
            break;
          case '0':
            this.glideTo({ x: 0.5, y: 0.5, scale: 1 }, 600);
            break;
          case 'ArrowUp':
            this.cam.y -= pan / Math.max(1, this.cam.scale);
            this.clampCam(this.cam); this.apply();
            break;
          case 'ArrowDown':
            this.cam.y += pan / Math.max(1, this.cam.scale);
            this.clampCam(this.cam); this.apply();
            break;
          case 'ArrowLeft':
            this.cam.x -= pan / Math.max(1, this.cam.scale);
            this.clampCam(this.cam); this.apply();
            break;
          case 'ArrowRight':
            this.cam.x += pan / Math.max(1, this.cam.scale);
            this.clampCam(this.cam); this.apply();
            break;
          default:
            break;
        }
      });
    }

    zoomAt(clientX, clientY, factor, smooth) {
      const rect = this.el.getBoundingClientRect();
      const px = clientX - rect.left, py = clientY - rect.top;
      const { w } = this.fitScale();
      const W = w * this.cam.scale;
      const H = W / this.aspect;
      // image-normalized point under cursor
      const ix = (px - (rect.width / 2 - this.cam.x * W)) / W;
      const iy = (py - (rect.height / 2 - this.cam.y * H)) / H;
      const newScale = this.cam.scale * factor;
      // keep (ix, iy) fixed under cursor: cam.x' = ix - (px - vw/2)/W'
      const W2 = w * newScale;
      const H2 = W2 / this.aspect;
      const nx = ix - (px - rect.width / 2) / W2;
      const ny = iy - (py - rect.height / 2) / H2;
      const target = this.clampCam({ x: nx, y: ny, scale: newScale });
      if (smooth) this.glideTo(target, 420);
      else { this.cam = target; this.apply(); }
    }

    resize() { this.clampCam(this.cam); this.apply(); }

    /* ---------- programmatic camera control (used by the app's shortcuts) ---------- */

    zoomBy(factor) {
      this._interrupt();
      this.zoomAt(this.el.clientWidth / 2, this.el.clientHeight / 2, factor, true);
    }
    resetView() {
      this._interrupt();
      this.glideTo({ x: 0.5, y: 0.5, scale: 1 }, 600);
    }
  }

  window.KepplerViewer = Viewer;
})();
