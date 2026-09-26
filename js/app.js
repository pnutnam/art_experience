/* The Keppler Rooms — tour engine
 * Walks the visitor through welcome → four rooms → finale, playing one
 * narration beat at a time, choreographing the camera (the guide's gaze),
 * and opening a private journal at every Socratic question.
 */
(function () {
  'use strict';

  const DATA = window.TOUR_DATA;
  const LQIP = window.LQIP || {};
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const ASPECTS = { sheol: 8833 / 5591, prodigal_father: 8750 / 5449, yorktown: 8369 / 5369, bosses_senate: 5832 / 4602 };

  /* ---------- persistent state ---------- */

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ } },
  };
  const settings = store.get('keppler.settings.v1', {});
  let journal = store.get('keppler.journal.v1', {});
  let progress = store.get('keppler.progress.v1', null); // {stop, beat}

  /* ---------- tour model ---------- */

  const TOUR = { stops: [{ id: '_welcome', isWelcome: true, beats: DATA.welcome.beats, ...DATA.welcome }].concat(DATA.stops) };
  let cur = { stop: 0, beat: 0 };
  let finished = false;

  function stopAt(i) { return TOUR.stops[i]; }
  function beatAt(s, b) { return TOUR.stops[s].beats[b]; }
  function lastBeatOf(s) { return TOUR.stops[s].beats.length - 1; }

  function sequencePos(s, b) { // flat position for display
    if (TOUR.stops[s].isWelcome) return { room: 'Welcome', n: b + 1, total: TOUR.stops[s].beats.length };
    return { room: stopAt(s).room, n: b + 1, total: TOUR.stops[s].beats.length };
  }

  /* ---------- elements ---------- */

  const el = {
    landing: $('#landing'), stage: $('#stage'), finale: $('#finale'),
    ghost: $('#landing-ghost'),
    begin: $('#btn-begin'), resume: $('#btn-resume'), resumeAt: $('#resume-at'),
    viewerHost: $('#viewer'),
    roomCard: $('#room-card'),
    hudRoomLabel: $('#hud-room-label'), hudRoomTitle: $('#hud-room-title'),
    btnContents: $('#btn-contents'), btnTranscript: $('#btn-transcript'), btnExit: $('#btn-exit'),
    btnNotes: $('#btn-notes'),
    transcript: $('#transcript'), transcriptText: $('#transcript-text'),
    contents: $('#contents'), contentsList: $('#contents-list'),
    notes: $('#notes'), notesTitle: $('#notes-title'), notesBody: $('#notes-body'),
    play: $('#btn-play'), prev: $('#btn-prev'), next: $('#btn-next'),
    iconPlay: $('#icon-play'), iconPause: $('#icon-pause'),
    dots: $('#beat-dots'), nowPlaying: $('#now-playing'), timeLeft: $('#time-left'),
    askCard: $('#ask-card'), askQ: $('#ask-q'), askKicker: $('#ask-kicker'),
    askInput: $('#ask-input'), hintBtn: $('#hint-btn'), askHint: $('#ask-hint'),
    btnContinue: $('#btn-continue'),
    silence: $('#silence-note'), silenceFill: $('#silence-fill'), silenceSkip: $('#silence-skip'),
    gesture: $('#gesture-note'),
    journalList: $('#journal-list'), btnExport: $('#btn-export'), btnClear: $('#btn-clear-journal'),
    finaleRooms: $('#finale-rooms'), finaleCredits: $('#finale-credits'),
  };

  const viewer = new window.KepplerViewer(el.viewerHost);
  viewer.onUserInteract = () => { /* camera grabbed mid-glide — that's allowed */ };
  viewer.onNeedFull = () => requestFull();

  let fullTimer = null;
  function currentImageName() {
    const s = stopAt(cur.stop);
    return s.image || null;
  }
  function requestFull() {
    const name = currentImageName();
    if (!name) return;
    viewer.requestFull({ webp: DATA.images[name].webp, full: DATA.images[name].full });
  }

  /* ---------- audio engine ---------- */

  const audio = new Audio();
  audio.preload = 'auto';
  let wantPlaying = false;
  let askPending = false;                // ask card is open / awaiting continue
  let sentences = [];                    // for transcript highlight
  let highlightRAF = null;
  const missingBeats = new Set();        // files known bad → device voice, per beat only

  audio.addEventListener('ended', () => onBeatFinished());
  audio.addEventListener('timeupdate', () => updateClock());

  // Quiet health check at boot: mark beats whose MP3 is absent or tiny so the
  // tour never surprises the visitor mid-room; transient failures later are
  // handled per-beat by the error listener and self-heal on the next beat.
  (async function healthCheck() {
    const ids = [];
    TOUR.stops.forEach(s => s.beats.forEach(b => { if (b.audio) ids.push(b.id); }));
    await Promise.all(ids.map(async (id) => {
      try {
        const r = await fetch(DATA.audioBase + id + '.mp3', { method: 'HEAD' });
        const len = parseInt(r.headers.get('content-length') || '0', 10);
        if (!r.ok || len < 2000) missingBeats.add(id);
      } catch { /* no network read — let per-beat fallback decide */ }
    }));
    if (missingBeats.size) console.warn('[keppler] beats without healthy audio (device voice will speak them):', [...missingBeats]);
  })();

  function playRecorded(beat) {
    const url = DATA.audioBase + beat.id + '.mp3';
    audio.src = url;
    audio.playbackRate = 1;
    const p = audio.play();
    if (p) p.catch(() => showGesture());
  }

  /* device-voice fallback (speechSynthesis) */
  const synth = window.speechSynthesis;
  let synthQueue = [], synthIdx = 0, synthActive = false;
  function synthVoice() {
    if (!synth) return null;
    const vs = synth.getVoices().filter(v => v.lang && v.lang.startsWith('en'));
    return vs.find(v => /aria|jenny|samantha|google us english/i.test(v.name)) || vs[0] || null;
  }
  function playSynth(beat) {
    if (!synth) { onBeatFinished(); return; }
    synth.cancel();
    synthQueue = splitSentences(beat.audio);
    synthIdx = 0;
    const start = () => speakNext(beat);
    if (synth.getVoices().length) { synthActive = true; start(); return; }
    // No voices populated yet: wait briefly for the platform; if none arrive
    // (headless/stripped browsers), advance instead of stalling the tour.
    let began = false;
    const begin = () => { if (began) return; began = true; synthActive = true; start(); };
    const giveUp = () => { if (began) return; began = true; synthActive = false; onBeatFinished(); };
    synth.addEventListener('voiceschanged', begin, { once: true });
    setTimeout(() => { synth.getVoices().length ? begin() : giveUp(); }, 1200);
  }
  function speakNext(beat) {
    if (synthIdx >= synthQueue.length) { synthActive = false; onBeatFinished(); return; }
    const u = new SpeechSynthesisUtterance(synthQueue[synthIdx]);
    const v = synthVoice(); if (v) u.voice = v;
    u.rate = 0.94; u.pitch = 1;
    u.onend = () => { if (!synthActive) return; synthIdx++; highlightSentence(synthIdx, true); speakNext(beat); };
    u.onerror = () => { synthActive = false; onBeatFinished(); };
    synth.speak(u);
    highlightSentence(synthIdx, true);
  }

  function startAudio(beat) {
    if (!beat.audio) return;
    buildTranscript(beat);
    if (missingBeats.has(beat.id)) playSynth(beat);
    else playRecorded(beat);
    startHighlightLoop();
  }

  function pauseAudio() {
    if (audio.src && !audio.paused) audio.pause();
    else if (synth && synthActive) synth.pause();
  }
  function resumeAudio() {
    if (audio.src && audio.currentTime > 0) { const p = audio.play(); if (p) p.catch(() => showGesture()); }
    else if (synth && synthActive) synth.resume();
  }
  function stopAudio() {
    wantPlaying = false;
    stopHighlightLoop();
    audio.pause();
    try { audio.currentTime = 0; } catch { }
    if (synth) { synthActive = false; synth.cancel(); }
  }

  function showGesture() {
    el.gesture.hidden = false;
    const once = () => { el.gesture.hidden = true; resumeAudio(); document.removeEventListener('pointerdown', once); };
    document.addEventListener('pointerdown', once);
  }

  /* ---------- transcript ---------- */

  function splitSentences(text) {
    const out = [];
    const parts = text.split(/(?<=[.!?…])\s+/);
    let buf = '';
    for (const p of parts) {
      buf += (buf ? ' ' : '') + p;
      if (buf.length > 40) { out.push(buf); buf = ''; }
    }
    if (buf) out.push(buf);
    return out;
  }

  function buildTranscript(beat) {
    sentences = beat.audio ? splitSentences(beat.audio) : [];
    el.transcriptText.innerHTML = sentences
      .map((s, i) => `<span class="sent" data-i="${i}">${esc(s)} </span>`).join('');
    el.transcriptText.classList.toggle('empty', !sentences.length);
    if (!sentences.length) el.transcriptText.textContent = beat.kind === 'silence' ? '( a quiet minute with the picture )' : '';
  }
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function highlightSentence(i, exact) {
    $$('.sent').forEach((n, k) => {
      n.classList.toggle('is-spoken', k < i || (exact && k === i));
      n.classList.toggle('is-now-sent', exact ? k === i : k === i);
    });
  }

  function startHighlightLoop() {
    stopHighlightLoop();
    highlightRAF = setInterval(() => {
      if (missingBeats.has(beatAt(cur.stop, cur.beat)?.id) || !audio.duration) return;
      const frac = audio.currentTime / audio.duration;
      const totalLen = sentences.reduce((a, s) => a + s.length, 0) || 1;
      let acc = 0, idx = 0;
      for (let k = 0; k < sentences.length; k++) {
        acc += sentences[k].length;
        if (acc / totalLen <= frac) idx = k + 1; else break;
      }
      highlightSentence(idx, false);
    }, 400);
  }
  function stopHighlightLoop() { if (highlightRAF) { clearInterval(highlightRAF); highlightRAF = null; } }

  function updateClock() {
    if (!audio.duration) { el.timeLeft.textContent = ''; return; }
    const remain = Math.max(0, audio.duration - audio.currentTime);
    el.timeLeft.textContent = fmtTime(remain);
  }
  function fmtTime(s) {
    const m = Math.floor(s / 60), ss = Math.round(s % 60);
    return `${m}:${String(ss).padStart(2, '0')}`;
  }

  /* ---------- engine ---------- */

  function goTo(s, b, autoplay = true, immediate = false) {
    stopAudio();
    hideAskCard();
    hideSilence();
    cur = { stop: s, beat: b };
    progress = { ...cur };
    store.set('keppler.progress.v1', progress);
    const stop = stopAt(s);
    const beat = beatAt(s, b);

    // image / room setup happens on beat 0 of a stop
    if (b === 0 && !stop.isWelcome) enterStopVisuals(stop);

    el.stage.classList.toggle('welcome-mode', !!stop.isWelcome);
    if (stop.isWelcome) {
      const name = DATA.welcome.ghostImage;
      viewer.setImage({ lqip: LQIP[name], mid: DATA.images[name].mid }, ASPECTS[name]);
    }

    renderHUD();
    renderBeat(beat);

    wantPlaying = autoplay;
    if (autoplay) {
      if (immediate) { beginBeat(beat); } // keep the click gesture alive (iOS)
      else setTimeout(() => { if (wantPlaying && cur.stop === s && cur.beat === b) beginBeat(beat); }, 420);
    } else {
      setPlayIcon(false);
    }
  }

  function enterStopVisuals(stop) {
    const name = stop.image;
    viewer.setImage({ lqip: LQIP[name], mid: DATA.images[name].mid }, ASPECTS[name]);
    clearTimeout(fullTimer);
    fullTimer = setTimeout(requestFull, 7000); // prefetch for smooth zooming
  }

  function beginBeat(beat) {
    setPlayIcon(true);
    if (beat.kind === 'card') {
      showRoomCard(beat);
      startAudio(beat);
    } else if (beat.kind === 'silence') {
      el.roomCard.hidden = true;
      startSilence(beat);
    } else {
      el.roomCard.hidden = true;
      if (beat.focus) viewer.glideTo({ x: beat.focus.x, y: beat.focus.y, scale: beat.focus.scale }, 2900);
      else if (beat.kind === 'ask' || beat.kind === 'reflect') viewer.glideTo({ x: 0.5, y: 0.5, scale: 1 }, 2400);
      startAudio(beat);
    }
  }

  function onBeatFinished() {
    stopHighlightLoop();
    if (!wantPlaying) return;
    const beat = beatAt(cur.stop, cur.beat);
    if (beat.kind === 'ask' || beat.kind === 'reflect') {
      showAskCard(beat);
    } else {
      advance();
    }
  }

  function advance() {
    const s = cur.stop, b = cur.beat;
    if (b < lastBeatOf(s)) { goTo(s, b + 1); return; }
    if (s + 1 < TOUR.stops.length) { goTo(s + 1, 0); return; }
    finishTour();
  }

  function finishTour() {
    stopAudio();
    finished = true;
    store.set('keppler.progress.v1', null);
    showScene('finale');
    renderFinale();
  }

  /* ---------- beats ---------- */

  function showRoomCard(beat) {
    const stop = stopAt(cur.stop);
    $('#room-card-room').textContent = stop.room || '';
    $('#room-card-title').textContent = stripQuotes(stop.title);
    $('#room-card-date').textContent = stop.date || '';
    $('#room-card-medium').textContent = stop.medium || '';
    el.roomCard.hidden = false;
  }

  let dwellTimer = null, dwellState = null;
  function startSilence(beat, remaining) {
    const total = dwellState ? dwellState.total : (beat.dwell || 24) * 1000;
    const ms = remaining != null ? remaining : total;
    dwellState = { total, t0: performance.now() - (total - ms) };
    el.silence.hidden = false;
    const frac = ms / total;
    el.silenceFill.style.transition = 'none';
    el.silenceFill.style.transform = `scaleX(${frac})`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.silenceFill.style.transition = `transform ${ms}ms linear`;
      el.silenceFill.style.transform = 'scaleX(0)';
    }));
    clearInterval(dwellTimer);
    dwellTimer = setInterval(() => {
      if (!wantPlaying) return;
      if (performance.now() - dwellState.t0 >= total) {
        clearInterval(dwellTimer); hideSilence(); advance();
      }
    }, 200);
  }
  function pauseSilence() {
    if (!dwellState) return;
    clearInterval(dwellTimer);
    const elapsed = Math.min(performance.now() - dwellState.t0, dwellState.total);
    dwellState.remaining = Math.max(0, dwellState.total - elapsed);
    el.silenceFill.style.transition = 'none';
    const r = getComputedStyle(el.silenceFill).transform;
    el.silenceFill.style.transform = r === 'none' ? 'scaleX(0)' : r;
  }
  function resumeSilence() {
    if (!dwellState) return;
    startSilence(null, dwellState.remaining != null ? dwellState.remaining : undefined);
  }
  function hideSilence() {
    clearInterval(dwellTimer);
    dwellState = null;
    el.silence.hidden = true;
    el.silenceFill.style.transition = 'none';
  }

  function showAskCard(beat) {
    setPlayIcon(false);
    askPending = true;
    el.askQ.textContent = beat.question || '';
    el.askInput.value = journal[beat.id]?.answer || '';
    el.askInput.placeholder = beat.placeholder || '';
    el.askHint.textContent = beat.hint || '';
    el.askHint.hidden = true;
    el.askKicker.textContent = beat.kind === 'reflect' ? 'Before we leave this room' : 'A question, for you alone';
    el.askCard.hidden = false;
    el.stage.classList.add('dimmed');
    if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => el.askInput.focus({ preventScroll: true }), 450);
  }
  function hideAskCard() {
    askPending = false;
    el.askCard.hidden = true;
    el.stage.classList.remove('dimmed');
  }

  /* ---------- HUD ---------- */

  function stripQuotes(s) { return s.replace(/^“|”$/g, ''); }

  function renderHUD() {
    const stop = stopAt(cur.stop);
    el.hudRoomLabel.textContent = stop.isWelcome ? 'Welcome' : stop.room;
    el.hudRoomTitle.textContent = stop.isWelcome ? 'The Keppler Rooms' : stripQuotes(stop.title);
    // dots
    el.dots.innerHTML = '';
    stop.beats.forEach((b, i) => {
      const d = document.createElement('button');
      d.className = 'beat-dot' + ((b.kind === 'ask' || b.kind === 'reflect') ? ' is-ask' : '');
      d.title = `Beat ${i + 1}`;
      d.setAttribute('aria-label', `Beat ${i + 1}`);
      if (i < cur.beat) d.classList.add('is-past');
      if (i === cur.beat) d.classList.add('is-now');
      d.addEventListener('click', () => goTo(cur.stop, i));
      el.dots.appendChild(d);
    });
  }

  function renderBeat(beat) {
    const pos = sequencePos(cur.stop, cur.beat);
    const kindLabel = beat.kind === 'ask' ? 'a question for you' :
      beat.kind === 'reflect' ? 'a last question' :
      beat.kind === 'silence' ? 'quiet looking' :
      beat.kind === 'card' ? 'entering the room' : 'the guide';
    el.nowPlaying.textContent = `${kindLabel} · ${pos.n} of ${pos.total}`;
    el.timeLeft.textContent = '';
    buildTranscript(beat);
  }

  function setPlayIcon(playing) {
    el.iconPlay.style.display = playing ? 'none' : 'block';
    el.iconPause.style.display = playing ? 'block' : 'none';
    el.play.classList.toggle('is-paused', !playing);
    el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  /* ---------- panels ---------- */

  function togglePanel(name) {
    const p = el[name];
    const open = p.hidden;
    for (const k of ['transcript', 'contents', 'notes']) el[k].hidden = true;
    p.hidden = !open;
    syncPanelButtons();
  }
  $$('[data-close]').forEach(b => b.addEventListener('click', () => { el[b.dataset.close].hidden = true; syncPanelButtons(); }));
  function syncPanelButtons() {
    el.btnTranscript.setAttribute('aria-pressed', String(!el.transcript.hidden));
    el.btnContents.setAttribute('aria-pressed', String(!el.contents.hidden));
    el.btnNotes.setAttribute('aria-pressed', String(!el.notes.hidden));
  }

  function renderNotes() {
    const stop = stopAt(cur.stop);
    const notes = stop.notes || [];
    el.notesTitle.textContent = stop.isWelcome
      ? 'Notes & sources — how this tour looks'
      : `Notes & sources — ${stripQuotes(stop.title)}`;
    if (!notes.length) { el.notesBody.innerHTML = '<p class="notes-intro">No notes for this room yet.</p>'; return; }
    el.notesBody.innerHTML = '<p class="notes-intro">What the guide draws on, in brief — opened while the tour runs, or afterwards. Scholars differ; where they do, the notes say so.</p>';
    for (const n of notes) {
      const div = document.createElement('div');
      div.className = 'note-block';
      div.innerHTML = `<p class="note-head"></p><p class="note-text"></p>` + (n.cite ? `<p class="note-cite"></p>` : '');
      div.querySelector('.note-head').textContent = n.head;
      div.querySelector('.note-text').textContent = n.text;
      if (n.cite) div.querySelector('.note-cite').textContent = '— ' + n.cite;
      el.notesBody.appendChild(div);
    }
  }

  function renderContents() {
    el.contentsList.innerHTML = '';
    TOUR.stops.forEach((s, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'contents-item' + (i === cur.stop ? ' is-current' : '');
      const name = s.isWelcome ? DATA.welcome.ghostImage : s.image;
      btn.innerHTML =
        `<img class="contents-thumb" src="${DATA.images[name].thumb}" alt="">` +
        `<span><span class="contents-room-label">${s.isWelcome ? 'Welcome' : s.room}</span>` +
        `<br><span class="contents-title">${s.isWelcome ? 'How to look with the guide' : esc(stripQuotes(s.title))}</span>` +
        `<br><span class="contents-date">${s.isWelcome ? 'about 3 minutes' : s.date}</span></span>`;
      btn.addEventListener('click', () => { goTo(i, 0); togglePanel('contents'); });
      li.appendChild(btn);
      el.contentsList.appendChild(li);
    });
  }

  /* ---------- journal / finale ---------- */

  function saveJournalDraft() {
    const beat = beatAt(cur.stop, cur.beat);
    if (beat.kind !== 'ask' && beat.kind !== 'reflect') return;
    const val = el.askInput.value.trim();
    if (val) {
      const stop = stopAt(cur.stop);
      journal[beat.id] = {
        answer: el.askInput.value,
        question: beat.question,
        room: stop.isWelcome ? 'Welcome' : `${stop.room} — ${stripQuotes(stop.title)}`,
        updated: Date.now(),
      };
    } else if (journal[beat.id] && !el.askInput.value) {
      delete journal[beat.id]; // cleared the box
    }
    store.set('keppler.journal.v1', journal);
  }

  let draftTimer = null;
  el.askInput.addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveJournalDraft, 350);
  });

  function renderFinale() {
    // journal entries in tour order
    const order = [];
    TOUR.stops.forEach(s => s.beats.forEach(b => { if (b.kind === 'ask' || b.kind === 'reflect') order.push(b.id); }));
    const found = order.filter(id => journal[id]);
    el.journalList.innerHTML = '';
    if (!found.length) {
      el.journalList.innerHTML = '<p class="journal-empty">You kept your answers to yourself — that is allowed.<br>Next time, the journal is here if you want it.</p>';
    } else {
      found.forEach(id => {
        const j = journal[id];
        const div = document.createElement('div');
        div.className = 'journal-entry';
        div.innerHTML = `<h4>${esc(j.room || '')}</h4><p class="q">${esc(j.question || '')}</p><p class="a"></p>`;
        div.querySelector('.a').textContent = j.answer.trim();
        el.journalList.appendChild(div);
      });
    }
    // rooms
    el.finaleRooms.innerHTML = '';
    TOUR.stops.forEach((s, i) => {
      if (s.isWelcome) return;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'contents-item';
      btn.innerHTML =
        `<img class="contents-thumb" src="${DATA.images[s.image].thumb}" alt="">` +
        `<span><span class="contents-room-label">${s.room}</span><br>` +
        `<span class="contents-title">${esc(stripQuotes(s.title))}</span><br>` +
        `<span class="contents-date">${s.date}</span></span>`;
      btn.addEventListener('click', () => { showScene('stage'); goTo(i, 0); });
      li.appendChild(btn); el.finaleRooms.appendChild(li);
    });
    // credits
    el.finaleCredits.innerHTML = '';
    DATA.meta.credits.forEach(c => { const li = document.createElement('li'); li.textContent = c; el.finaleCredits.appendChild(li); });
    DATA.meta.sources.forEach(s => {
      const li = document.createElement('li');
      if (s.url) { const a = document.createElement('a'); a.href = s.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = s.label; li.appendChild(a); }
      else li.textContent = s.label;
      el.finaleCredits.appendChild(li);
    });
  }

  el.btnExport.addEventListener('click', () => {
    const lines = [`# The Keppler Rooms — my reflections`, `*${new Date().toLocaleString()}*`, ''];
    TOUR.stops.forEach(s => s.beats.forEach(b => {
      if ((b.kind === 'ask' || b.kind === 'reflect') && journal[b.id]) {
        lines.push(`## ${journal[b.id].room}`, `**${b.question}**`, '', journal[b.id].answer.trim(), '');
      }
    }));
    lines.push('—', `"${DATA.meta.motto}" — Puck, after Shakespeare`);
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'keppler-rooms-journal.md';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  el.btnClear.addEventListener('click', () => {
    if (!confirm('Clear all your written reflections from this device?')) return;
    journal = {}; store.set('keppler.journal.v1', journal); renderFinale();
  });

  /* ---------- scenes ---------- */

  function showScene(name) {
    el.landing.classList.toggle('is-active', name === 'landing');
    el.landing.hidden = name !== 'landing';
    el.stage.classList.toggle('is-active', name === 'stage');
    el.stage.hidden = name !== 'stage';
    el.finale.classList.toggle('is-active', name === 'finale');
    el.finale.hidden = name !== 'finale';
  }

  /* ---------- wiring ---------- */

  el.begin.addEventListener('click', () => { showScene('stage'); goTo(0, 0, true, true); });
  el.resume.addEventListener('click', () => {
    showScene('stage');
    if (progress) goTo(progress.stop, progress.beat, true, true);
    else goTo(0, 0, true, true);
  });

  el.play.addEventListener('click', togglePlay);
  function togglePlay() {
    if (askPending) return; // the card owns the flow
    const beat = beatAt(cur.stop, cur.beat);
    if (wantPlaying) {
      wantPlaying = false;
      pauseAudio();
      if (beat.kind === 'silence') pauseSilence();
      setPlayIcon(false);
    } else {
      wantPlaying = true;
      setPlayIcon(true);
      if (beat.kind === 'silence' && dwellState) resumeSilence();
      else if (audio.src && audio.currentTime > 0) resumeAudio();
      else if (synthActive) synth.resume();
      else beginBeat(beat);
    }
  }

  el.next.addEventListener('click', () => advance());
  el.prev.addEventListener('click', () => {
    const b = cur.beat;
    if (b > 0) goTo(cur.stop, b - 1);
    else if (cur.stop > 0) goTo(cur.stop - 1, lastBeatOf(cur.stop - 1));
  });

  el.btnContinue.addEventListener('click', () => {
    saveJournalDraft();
    hideAskCard();
    advance();
  });
  el.hintBtn.addEventListener('click', () => { el.askHint.hidden = !el.askHint.hidden; });
  el.silenceSkip.addEventListener('click', () => { hideSilence(); advance(); });

  el.btnContents.addEventListener('click', () => { renderContents(); togglePanel('contents'); });
  el.btnTranscript.addEventListener('click', () => togglePanel('transcript'));
  el.btnNotes.addEventListener('click', () => { renderNotes(); togglePanel('notes'); });
  el.btnExit.addEventListener('click', () => {
    stopAudio();
    store.set('keppler.progress.v1', { ...cur });
    updateResume();
    showScene('landing');
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (el.landing.hidden && el.finale.hidden) {
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      if (e.key === 'ArrowRight') advance();
      if (e.key === 'ArrowLeft') el.prev.click();
      if (e.key === 't' || e.key === 'T') togglePanel('transcript');
      if (e.key === 'c' || e.key === 'C') { renderContents(); togglePanel('contents'); }
      if (e.key === 'n' || e.key === 'N') { renderNotes(); togglePanel('notes'); }
    }
    if (e.key === 'Escape') { el.transcript.hidden = true; el.contents.hidden = true; el.notes.hidden = true; syncPanelButtons(); }
  });

  window.addEventListener('resize', () => viewer.resize());

  function updateResume() {
    const p = store.get('keppler.progress.v1', null);
    if (p && p.stop > 0) {
      const s = stopAt(p.stop);
      el.resume.hidden = false;
      el.resumeAt.textContent = `${s.room} · ${stripQuotes(s.title)}`;
    } else if (p && p.stop === 0 && p.beat > 0) {
      el.resume.hidden = false;
      el.resumeAt.textContent = 'the welcome';
    } else {
      el.resume.hidden = true;
    }
  }

  /* ---------- audio error fallback: this beat only, then self-heal ---------- */

  audio.addEventListener('error', () => {
    const beat = beatAt(cur.stop, cur.beat);
    if (!beat || !beat.audio) return;
    if (wantPlaying && !synthActive) {
      // The file for THIS beat failed to load — speak it with the device voice,
      // but do not downgrade the rest of the tour; the next beat retries recorded.
      missingBeats.add(beat.id);
      console.warn('[keppler] recorded audio failed for', beat.id, '— using device voice for this beat only');
      playSynth(beat);
    }
  });

  /* ---------- boot ---------- */

  el.ghost.style.backgroundImage = `url(${DATA.images[DATA.welcome.ghostImage || 'sheol'].mid})`;
  updateResume();
  showScene('landing');
})();
