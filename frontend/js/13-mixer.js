// ============================================================
// 13-mixer.js — Mixer multistem FULL-AREA v4
// Faders CSS puro (div+thumb) que respetan flex y se auto-ajustan.
// ============================================================

(function () {

  const mixerState = {
    sessionId: getGenUUID(),
    stems: {},
    stemLibrary: [],
    stemLibraryLoaded: false,
    jobId: null,
    polling: null,
  };

  // ── Helpers globales de respaldo / seguridad ───────────────────────────────
  function getAPI() {
    return typeof API === 'function' ? API() : (window.API ? window.API() : '');
  }

  function getGenUUID() {
    if (typeof genUUID === 'function') return genUUID();
    if (typeof window.genUUID === 'function') return window.genUUID();
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  function formatDbValue(db) {
    if (typeof window.formatDbValue === 'function') return window.formatDbValue(db);
    const num = parseFloat(db) || 0;
    return (num >= 0 ? '+' : '') + num.toFixed(1) + ' dB';
  }

  function formatLinearThresholdToDb(val) {
    if (typeof window.formatLinearThresholdToDb === 'function') return window.formatLinearThresholdToDb(val);
    const v = Math.max(parseFloat(val) || 0, 1e-6);
    const db = 20 * Math.log10(v);
    return db.toFixed(1) + ' dB';
  }

  // ── Live preview engine (Web Audio API) ─────────────────────────────────────
  const previewEngine = {
    ctx: null,
    masterGain: null,
    nodes: {},      // stemName -> chain de AudioNodes persistente
    buffers: {},    // stemName -> AudioBuffer decodificado
    playing: false,
    position: 0,       // segundos, posición lógica (pausa/seek)
    startCtxTime: 0,    // ctx.currentTime en el que arrancó la reproducción actual
    startOffset: 0,      // posición de audio al arrancar la reproducción actual
    duration: 0,
    rafId: null,
    endTimer: null,
  };

  function dbToLin(db) { return Math.pow(10, db / 20); }

  function ensureAudioCtx() {
    if (!previewEngine.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      previewEngine.ctx = new AC();
      previewEngine.masterGain = previewEngine.ctx.createGain();
      previewEngine.masterGain.connect(previewEngine.ctx.destination);
      const masterDb = parseFloat(document.getElementById('mix-master-gain')?.value || 0);
      previewEngine.masterGain.gain.value = dbToLin(masterDb);
    }
    return previewEngine.ctx;
  }

  async function decodeStemForPreview(name, file) {
    try {
      const ctx = ensureAudioCtx();
      const arrBuf = await file.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrBuf.slice(0));
      previewEngine.buffers[name] = audioBuf;
      if (previewEngine.playing) startStemSource(name, getPreviewPosition());
      updateTransportUI();
    } catch (err) {
      console.warn(`No se pudo decodificar "${name}" para preview:`, err);
    }
  }

  function ensureStemChain(name) {
    if (previewEngine.nodes[name]) return previewEngine.nodes[name];
    const ctx = ensureAudioCtx();
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.707;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';  lp.Q.value = 0.707;
    const eqLow   = ctx.createBiquadFilter(); eqLow.type   = 'peaking';
    const eqLoMid = ctx.createBiquadFilter(); eqLoMid.type = 'peaking';
    const eqHiMid = ctx.createBiquadFilter(); eqHiMid.type = 'peaking';
    const eqHigh  = ctx.createBiquadFilter(); eqHigh.type  = 'peaking';
    const comp = ctx.createDynamicsCompressor();
    const gainNode = ctx.createGain();
    const panNode = ctx.createStereoPanner();
    const muteSoloGain = ctx.createGain();

    hp.connect(lp); lp.connect(eqLow); eqLow.connect(eqLoMid); eqLoMid.connect(eqHiMid);
    eqHiMid.connect(eqHigh); eqHigh.connect(comp); comp.connect(gainNode);
    gainNode.connect(panNode); panNode.connect(muteSoloGain);
    muteSoloGain.connect(previewEngine.masterGain);

    const chain = { hp, lp, eqLow, eqLoMid, eqHiMid, eqHigh, comp, gainNode, panNode, muteSoloGain, source: null };
    previewEngine.nodes[name] = chain;
    return chain;
  }

  function applyStemParamsToChain(name) {
    if (!previewEngine.ctx) return;
    const chain = previewEngine.nodes[name];
    const p = mixerState.stems[name]?.params;
    if (!chain || !p) return;
    const t = previewEngine.ctx.currentTime;
    const ramp = (audioParam, val) => audioParam.setTargetAtTime(val, t, 0.015);
    ramp(chain.hp.frequency, p.hp_cutoff_hz);
    ramp(chain.lp.frequency, Math.min(p.lp_cutoff_hz, previewEngine.ctx.sampleRate / 2 - 100));
    ramp(chain.eqLow.frequency,   p.eq_low_freq);   ramp(chain.eqLow.gain,   p.eq_low_gain_db);   ramp(chain.eqLow.Q,   p.eq_low_q);
    ramp(chain.eqLoMid.frequency, p.eq_lomid_freq); ramp(chain.eqLoMid.gain, p.eq_lomid_gain_db); ramp(chain.eqLoMid.Q, p.eq_lomid_q);
    ramp(chain.eqHiMid.frequency, p.eq_himid_freq); ramp(chain.eqHiMid.gain, p.eq_himid_gain_db); ramp(chain.eqHiMid.Q, p.eq_himid_q);
    ramp(chain.eqHigh.frequency,  p.eq_high_freq);  ramp(chain.eqHigh.gain,  p.eq_high_gain_db);  ramp(chain.eqHigh.Q,  p.eq_high_q);
    if (p.comp_enabled) {
      const thrDb = 20 * Math.log10(Math.max(p.comp_threshold, 1e-6));
      chain.comp.threshold.setTargetAtTime(Math.max(-100, thrDb), t, 0.02);
      chain.comp.ratio.setTargetAtTime(Math.min(20, Math.max(1, p.comp_ratio)), t, 0.02);
      chain.comp.attack.setTargetAtTime(Math.max(0.001, p.comp_attack_ms / 1000), t, 0.01);
      chain.comp.release.setTargetAtTime(Math.max(0.01, p.comp_release_ms / 1000), t, 0.01);
    } else {
      chain.comp.threshold.setTargetAtTime(0, t, 0.02);
      chain.comp.ratio.setTargetAtTime(1, t, 0.02);
    }
    const makeupLin = p.comp_enabled ? dbToLin(p.comp_makeup_db) : 1;
    ramp(chain.gainNode.gain, dbToLin(p.gain_db) * makeupLin);
    ramp(chain.panNode.pan, p.pan);
  }

  function updateAllMuteSolo() {
    if (!previewEngine.ctx) return;
    const stems = mixerState.stems;
    const anySolo = Object.values(stems).some(s => s.params.solo);
    const t = previewEngine.ctx.currentTime;
    for (const [name, s] of Object.entries(stems)) {
      const chain = previewEngine.nodes[name];
      if (!chain) continue;
      const audible = !s.params.mute && (!anySolo || s.params.solo);
      chain.muteSoloGain.gain.setTargetAtTime(audible ? 1 : 0, t, 0.01);
    }
  }

  function getPreviewPosition() {
    if (!previewEngine.playing || !previewEngine.ctx) return previewEngine.position;
    return previewEngine.startOffset + (previewEngine.ctx.currentTime - previewEngine.startCtxTime);
  }

  function startStemSource(name, atPosition) {
    const buf = previewEngine.buffers[name];
    if (!buf) return;
    const chain = ensureStemChain(name);
    applyStemParamsToChain(name);
    if (chain.source) { try { chain.source.stop(); } catch (e) {} }
    const src = previewEngine.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(chain.hp);
    const offset = Math.min(Math.max(atPosition, 0), buf.duration);
    try { src.start(previewEngine.ctx.currentTime, offset); } catch (e) {}
    chain.source = src;
  }

  function playPreview() {
    const names = Object.keys(mixerState.stems).filter(n => previewEngine.buffers[n]);
    ensureAudioCtx();
    if (previewEngine.ctx.state === 'suspended') previewEngine.ctx.resume();
    if (!names.length) { updateTransportUI(); return; }
    previewEngine.duration = Math.max(0, ...names.map(n => previewEngine.buffers[n].duration));
    if (previewEngine.position >= previewEngine.duration) previewEngine.position = 0;
    const startOffset = previewEngine.position;
    names.forEach(name => startStemSource(name, startOffset));
    previewEngine.playing = true;
    previewEngine.startCtxTime = previewEngine.ctx.currentTime;
    previewEngine.startOffset = startOffset;
    updateAllMuteSolo();
    clearTimeout(previewEngine.endTimer);
    const remaining = Math.max(0, previewEngine.duration - startOffset);
    previewEngine.endTimer = setTimeout(() => stopPreview(true), remaining * 1000 + 60);
    updateTransportUI();
    tickTransport();
  }

  function stopPreview(resetToStart) {
    if (previewEngine.ctx) {
      Object.values(previewEngine.nodes).forEach(chain => {
        if (chain.source) { try { chain.source.stop(); } catch (e) {} chain.source = null; }
      });
    }
    previewEngine.position = resetToStart ? 0 : getPreviewPosition();
    previewEngine.playing = false;
    clearTimeout(previewEngine.endTimer);
    cancelAnimationFrame(previewEngine.rafId);
    updateTransportUI();
  }

  function togglePreview() { previewEngine.playing ? stopPreview(false) : playPreview(); }

  function seekPreview(seconds) {
    const wasPlaying = previewEngine.playing;
    if (wasPlaying) stopPreview(false);
    previewEngine.position = Math.max(0, Math.min(seconds, previewEngine.duration || seconds));
    updateTransportUI();
    if (wasPlaying) playPreview();
  }

  function fmtTime(s) {
    if (!Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function updateTransportUI() {
    const btn = document.getElementById('mxrPlayBtn');
    const seek = document.getElementById('mxrSeek');
    const time = document.getElementById('mxrTimeLabel');
    if (btn) btn.textContent = previewEngine.playing ? '⏸' : '▶';
    const pos = getPreviewPosition();
    if (seek) {
      seek.max = previewEngine.duration || 0;
      if (document.activeElement !== seek) seek.value = pos;
    }
    if (time) time.textContent = `${fmtTime(pos)} / ${fmtTime(previewEngine.duration)}`;
  }

  function tickTransport() {
    if (!previewEngine.playing) return;
    updateTransportUI();
    previewEngine.rafId = requestAnimationFrame(tickTransport);
  }

  function removeStemFromPreview(name) {
    const chain = previewEngine.nodes[name];
    if (chain) {
      if (chain.source) { try { chain.source.stop(); } catch (e) {} }
      chain.muteSoloGain.disconnect();
    }
    delete previewEngine.nodes[name];
    delete previewEngine.buffers[name];
  }

  function resetPreviewEngine() {
    stopPreview(true);
    Object.keys(previewEngine.nodes).forEach(removeStemFromPreview);
  }

  // ── Server preview (chain completo real, vía /ws/mix-stream) ────────────────
  const serverPreview = { enabled: false, ws: null, debounceTimer: null, rendering: false };

  function setServerPreviewStatus(txt) {
    const el = document.getElementById('mxrServerPreviewStatus');
    if (el) el.textContent = txt;
  }

  function scheduleServerPreview() {
    if (!serverPreview.enabled) return;
    clearTimeout(serverPreview.debounceTimer);
    setServerPreviewStatus('Esperando…');
    serverPreview.debounceTimer = setTimeout(runServerPreview, 700);
  }

  async function runServerPreview() {
    const names = Object.keys(mixerState.stems).filter(n => mixerState.stems[n].uploaded);
    if (!names.length) { setServerPreviewStatus('Subí al menos un stem.'); return; }
    if (serverPreview.ws) { try { serverPreview.ws.close(); } catch (e) {} serverPreview.ws = null; }
    serverPreview.rendering = true;
    setServerPreviewStatus('Renderizando en el servidor…');
    const stemParams = {};
    names.forEach(n => stemParams[n] = mixerState.stems[n].params);
    const mixParamsPayload = {
      master_gain_db: parseFloat(document.getElementById('mix-master-gain')?.value || 0),
      target_lufs:    parseFloat(document.getElementById('mix-lufs')?.value || -14),
      normalize_before_master: document.getElementById('mix-normalize')?.checked ?? true,
      chain_params: {},
    };
    const pcmChunks = [];
    let sampleRate = 44100, channels = 2;
    try {
      await new Promise((resolve, reject) => {
        const wsUrl = typeof wsUrlFor === 'function' ? wsUrlFor('/ws/mix-stream') : '/ws/mix-stream';
        const ws = new WebSocket(wsUrl);
        serverPreview.ws = ws;
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          ws.send(JSON.stringify({
            session_id: mixerState.sessionId,
            stem_names: names,
            stem_library_ids: buildStemLibraryIdMap(names),
            stem_params: stemParams,
            mix_params: mixParamsPayload,
            chunk_seconds: 1.0,
            preview_seconds: 12,
            sr: 44100,
          }));
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
            if (msg.event === 'chunk') { sampleRate = msg.sample_rate; channels = msg.channels; }
            if (msg.event === 'error') reject(new Error(msg.message || 'Error de preview'));
            if (msg.event === 'done') resolve();
          } else {
            pcmChunks.push(ev.data);
          }
        };
        ws.onerror = () => reject(new Error('No se pudo abrir /ws/mix-stream'));
        ws.onclose = () => { if (!pcmChunks.length) reject(new Error('Streaming cerrado sin audio')); };
      });

      if (typeof wavBlobFromPcm16 === 'function') {
        const blob = wavBlobFromPcm16(pcmChunks, sampleRate, channels);
        const audioEl = document.getElementById('mxrServerPreviewAudio');
        if (audioEl) {
          if (audioEl.dataset.blobUrl) URL.revokeObjectURL(audioEl.dataset.blobUrl);
          const url = URL.createObjectURL(blob);
          audioEl.dataset.blobUrl = url;
          audioEl.src = url;
          audioEl.play().catch(() => {});
        }
      }
      setServerPreviewStatus(`Preview listo ✓ — ${names.length} stem${names.length !== 1 ? 's' : ''}`);
    } catch (err) {
      setServerPreviewStatus('Error: ' + err.message);
    } finally {
      serverPreview.rendering = false;
      if (serverPreview.ws) {
        try { serverPreview.ws.close(); } catch (e) {}
        serverPreview.ws = null;
      }
    }
  }

  // ── Params & helpers ──────────────────────────────────────────────────────
  function defaultStemParams(name) {
    return {
      name, stem_type: detectStemType(name),
      gain_db: 0, pan: 0, mute: false, solo: false,
      hp_cutoff_hz: 20, lp_cutoff_hz: 20000,
      eq_low_freq: 100,   eq_low_gain_db: 0,   eq_low_q: 0.8,
      eq_lomid_freq: 500, eq_lomid_gain_db: 0, eq_lomid_q: 1.0,
      eq_himid_freq: 3000,eq_himid_gain_db: 0, eq_himid_q: 1.0,
      eq_high_freq: 10000,eq_high_gain_db: 0,  eq_high_q: 0.8,
      comp_enabled: false, comp_threshold: 0.5, comp_ratio: 4,
      comp_attack_ms: 10, comp_release_ms: 100, comp_makeup_db: 0,
      comp_stereo_link: true, comp_pdr: true,
      transient_attack: 0, transient_sustain: 0,
      stereo_width_amount: 1.0,
      sidechain_trigger_name: null, sidechain_threshold: 0.3,
      sidechain_ratio: 6, sidechain_attack_ms: 5, sidechain_release_ms: 80,
    };
  }

  function detectStemType(name) {
    const n = name.toLowerCase();
    if (/kick|bd|bombo/.test(n))        return 'kick';
    if (/snare|caja|rim/.test(n))       return 'snare';
    if (/bass|bajo|808/.test(n))        return 'bass';
    if (/voc|voice|vocal|lead/.test(n)) return 'vocals';
    if (/guitar|guit/.test(n))          return 'guitar';
    if (/synth|pad|keys|piano/.test(n)) return 'synth';
    if (/drum|perc|hat|cymbal/.test(n)) return 'drums';
    if (/fx|effect|atm/.test(n))        return 'fx';
    return 'other';
  }

  function stemEmoji(t) {
    return ({kick:'🥁',snare:'🪘',bass:'🎸',vocals:'🎤',guitar:'🎸',
             synth:'🎹',drums:'🥁',fx:'✨',other:'🎵'})[t]||'🎵';
  }

  // ── CSS fader (div-based, no SVG) ────────────────────────────────────────
  const FADER_MIN = -60, FADER_MAX = 12;

  function dbToPct(db) {
    return Math.max(0, Math.min(1, (db - FADER_MIN) / (FADER_MAX - FADER_MIN)));
  }

  function faderHTML(id, db) {
    const pct = dbToPct(db);
    const topPct = ((1 - pct) * 100).toFixed(2);
    const fillPct = (pct * 100).toFixed(2);
    const zeroTopPct = ((1 - dbToPct(0)) * 100).toFixed(2);

    return `
      <div class="mxr-fader-css" data-fader-id="${id}" data-db="${db}"
           style="--knob-top:${topPct}%;--fill-h:${fillPct}%;--zero-top:${zeroTopPct}%"
           role="slider" aria-valuenow="${db}" aria-valuemin="${FADER_MIN}" aria-valuemax="${FADER_MAX}"
           tabindex="0">
        <div class="mxr-fader-track">
          <div class="mxr-fader-fill"></div>
          <div class="mxr-fader-zero"></div>
          <div class="mxr-fader-knob"></div>
        </div>
      </div>`;
  }

  function setFaderDb(faderId, db) {
    const el = document.querySelector(`.mxr-fader-css[data-fader-id="${faderId}"]`);
    if (!el) return;
    const pct = dbToPct(db);
    const topPct = ((1 - pct) * 100).toFixed(2);
    const fillPct = (pct * 100).toFixed(2);
    el.style.setProperty('--knob-top', topPct + '%');
    el.style.setProperty('--fill-h',  fillPct + '%');
    el.dataset.db = db;
    el.setAttribute('aria-valuenow', db);
  }

  // ── Drag logic ────────────────────────────────────────────────────────────
  function initFaderDrags(container) {
    container.querySelectorAll('.mxr-fader-css').forEach(el => {
      if (el._faderInited) return;
      el._faderInited = true;

      let dragging = false, startY = 0, startDb = 0;

      function getDb() { return parseFloat(el.dataset.db) || 0; }

      function applyDb(db) {
        db = Math.max(FADER_MIN, Math.min(FADER_MAX, db));
        setFaderDb(el.dataset.faderId, db);

        const id = el.dataset.faderId;
        if (id === 'master') {
          const inp = document.getElementById('mix-master-gain');
          if (inp) inp.value = db;
          const lbl = document.getElementById('mix-master-gain-val');
          if (lbl) lbl.textContent = formatDbValue(db);
          const lblCh = document.getElementById('mix-master-gain-val-ch');
          if (lblCh) lblCh.textContent = formatDbValue(db);
          if (previewEngine.ctx) previewEngine.masterGain.gain.setTargetAtTime(dbToLin(db), previewEngine.ctx.currentTime, 0.015);
          scheduleServerPreview();
        } else {
          const stemName = id.replace(/^gain:/, '');
          const p = mixerState.stems[stemName]?.params;
          if (p) p.gain_db = db;
          const lbl = document.getElementById('ch-gain-val-' + stemName);
          if (lbl) lbl.textContent = formatDbValue(db);
          if (previewEngine.nodes[stemName]) applyStemParamsToChain(stemName);
          scheduleServerPreview();
        }
      }

      function pxToDb(dy, trackH) {
        return startDb + (dy / trackH) * (FADER_MAX - FADER_MIN);
      }

      function getTrackH() {
        return el.querySelector('.mxr-fader-track')?.getBoundingClientRect().height || 200;
      }

      function onDown(e) {
        dragging = true;
        startY  = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
        startDb = getDb();
        document.body.style.userSelect = 'none';
        e.preventDefault();
      }
      function onMove(e) {
        if (!dragging) return;
        const cy = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
        const dy = startY - cy;
        applyDb(pxToDb(dy, getTrackH()));
      }
      function onUp() {
        dragging = false;
        document.body.style.userSelect = '';
      }

      el.addEventListener('mousedown',  onDown);
      el.addEventListener('touchstart', onDown, { passive: false });
      document.addEventListener('mousemove',  onMove);
      document.addEventListener('touchmove',  onMove, { passive: false });
      document.addEventListener('mouseup',    onUp);
      document.addEventListener('touchend',   onUp);

      el.addEventListener('dblclick', () => applyDb(0));

      el.addEventListener('keydown', e => {
        const step = e.shiftKey ? 1 : 0.5;
        if (e.key === 'ArrowUp')   { applyDb(getDb() + step); e.preventDefault(); }
        if (e.key === 'ArrowDown') { applyDb(getDb() - step); e.preventDefault(); }
      });
    });
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────
  function getMixerContentArea() { return document.getElementById('mixerContentArea'); }
  function getMixerSidePanel()   { return document.getElementById('mixerSidePanel'); }

  // Actualiza la cuenta de stems y la visibilidad del reproductor local
  function updateToolbarHeader() {
    const stemCount = Object.keys(mixerState.stems).length;
    const tag = document.querySelector('.mxr-title-tag');
    if (tag) {
      tag.textContent = `🎚 ${stemCount} stem${stemCount !== 1 ? 's' : ''}`;
    }

    const transport = document.getElementById('mxrTransport');
    if (transport) {
      transport.style.display = stemCount > 0 ? 'flex' : 'none';
    }
  }

  // ── Stem library ──────────────────────────────────────────────────────────
  function buildStemLibraryIdMap(names) {
    const out = {};
    names.forEach(n => {
      const id = mixerState.stems[n]?.libraryId;
      if (id) out[n] = id;
    });
    return out;
  }

  function normalizeStemName(name, fallback) {
    const base = (name || fallback || 'stem').replace(/\.[^.]+$/, '').trim();
    return base || 'stem';
  }

  async function refreshStemLibrary(force) {
    if (mixerState.stemLibraryLoaded && !force) return mixerState.stemLibrary;
    try {
      const res = await fetch(`${getAPI()}/mix/stem-library`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      mixerState.stemLibrary = data.files || [];
      mixerState.stemLibraryLoaded = true;
    } catch (err) {
      console.warn('No se pudo cargar la librería de stems:', err);
      mixerState.stemLibrary = [];
    }
    renderMixerSidePanel();
    return mixerState.stemLibrary;
  }

  async function addStemFromLibrary(item) {
    const stemName = normalizeStemName(item.original_filename, item.id);
    if (mixerState.stems[stemName] && !confirm(`Ya existe "${stemName}". ¿Reemplazar?`)) return;
    mixerState.stems[stemName] = {
      file: null,
      params: defaultStemParams(stemName),
      uploaded: true,
      duration: item.duration_sec,
      libraryId: item.id,
      libraryName: item.original_filename,
    };
    addChannelToDOM(stemName);
    try {
      const res = await fetch(`${getAPI()}/mix/stem-library/${item.id}/download`);
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      blob.name = item.original_filename || `${stemName}.wav`;
      await decodeStemForPreview(stemName, blob);
      document.getElementById('mixerSubmitBtn')?.removeAttribute('disabled');
      scheduleServerPreview();
    } catch (err) {
      console.warn('No se pudo preparar preview local del stem guardado:', err);
    }
  }

  async function deleteStemFromLibrary(item) {
    if (!confirm(`¿Borrar "${item.original_filename}" de la librería de stems?`)) return;
    try {
      const res = await fetch(`${getAPI()}/mix/stem-library/${item.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      mixerState.stemLibrary = mixerState.stemLibrary.filter(x => x.id !== item.id);
      renderMixerSidePanel();
    } catch (err) {
      alert('No se pudo borrar el stem: ' + err.message);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function renderMixer() {
    renderMixerContent();
    renderMixerSidePanel();
    const area = getMixerContentArea();
    if (area) initFaderDrags(area);
  }

  function renderMixerContent() {
    const area = getMixerContentArea();
    if (!area) return;
    const stemNames = Object.keys(mixerState.stems);

    area.innerHTML = `
      <div class="mxr-toolbar">
        <button class="btn btn-sm" id="mixerAddStemBtn">＋ Stem</button>
        <button class="btn btn-sm" id="mixerAddMultiBtn">📂 Multi</button>
        <button class="btn btn-sm" id="mixerLibraryBtn">📚 Librería</button>
        <input type="file" id="mixerFileInput" accept=".wav,.mp3,.flac,.ogg,.aiff,.aif" style="display:none">
        <input type="file" id="mixerMultiInput" accept=".wav,.mp3,.flac,.ogg,.aiff,.aif" multiple style="display:none">
        <span class="mxr-title-tag">🎚 ${stemNames.length} stem${stemNames.length!==1?'s':''}</span>
        <div class="mxr-transport" id="mxrTransport" style="${stemNames.length ? 'display:flex' : 'display:none'}">
          <button class="btn btn-sm" id="mxrPlayBtn" title="Preview en vivo (client-side)">▶</button>
          <input type="range" id="mxrSeek" class="mxr-seek" min="0" max="0" step="0.01" value="0">
          <span class="mxr-time" id="mxrTimeLabel">0:00 / 0:00</span>
        </div>
        <button class="btn btn-sm mxr-clear-btn" id="mixerClearBtn">🗑</button>
      </div>

      <div class="mxr-stage" id="mxrStage">
        ${stemNames.length === 0 ? `
          <div class="mxr-empty">
            <div class="mxr-empty-icon">🎚</div>
            <div class="mxr-empty-title">Arrastrá stems acá o usá los botones</div>
            <div class="mxr-empty-sub">WAV · MP3 · FLAC · OGG · AIFF — hasta 200MB</div>
            <div style="display:flex;gap:.5rem;margin-top:1rem;flex-wrap:wrap;justify-content:center">
              <button class="btn btn-primary" id="mxrDropBtn">＋ Elegir archivos</button>
              <button class="btn btn-ref" id="mxrEmptyLibraryBtn">📚 Usar librería</button>
            </div>
          </div>
        ` : `
          <div class="mxr-channels" id="mixerChannels">
            ${stemNames.map(n => renderChannel(n)).join('')}
            <div class="mxr-channel mxr-master-ch" id="mxrMasterCh">
              ${renderMasterChannel()}
            </div>
          </div>
        `}
      </div>
    `;

    updateToolbarHeader();
  }

  function addChannelToDOM(name) {
    const area = getMixerContentArea();
    if (!area) return;
    if (area.style.display === 'none') activateMixerMode();

    let stage    = document.getElementById('mxrStage');
    let channels = document.getElementById('mixerChannels');

    if (!stage) {
      renderMixerContent();
      bindMixerEvents();
      stage    = document.getElementById('mxrStage');
      channels = document.getElementById('mixerChannels');
    }

    if (stage && !channels) {
      stage.innerHTML = '';
      channels = document.createElement('div');
      channels.className = 'mxr-channels';
      channels.id = 'mixerChannels';
      stage.appendChild(channels);

      const masterEl = document.createElement('div');
      masterEl.className = 'mxr-channel mxr-master-ch';
      masterEl.id = 'mxrMasterCh';
      masterEl.innerHTML = renderMasterChannel();
      channels.appendChild(masterEl);
    }

    if (!channels) return;

    const existing = document.getElementById(`ch-${CSS.escape(name)}`);
    if (existing) existing.remove();

    const chEl = document.createElement('div');
    chEl.innerHTML = renderChannel(name).trim();
    const chNode = chEl.firstElementChild;
    const master = document.getElementById('mxrMasterCh');
    if (master) channels.insertBefore(chNode, master);
    else        channels.appendChild(chNode);

    initFaderDrags(area);
    updateToolbarHeader();
    renderMixerSidePanel();
  }

  function removeChannelFromDOM(name) {
    const el = document.getElementById(`ch-${CSS.escape(name)}`);
    if (el) el.remove();

    if (Object.keys(mixerState.stems).length === 0) {
      const stage = document.getElementById('mxrStage');
      if (stage) {
        stage.innerHTML = `
          <div class="mxr-empty">
            <div class="mxr-empty-icon">🎚</div>
            <div class="mxr-empty-title">Arrastrá stems acá o usá los botones</div>
            <div class="mxr-empty-sub">WAV · MP3 · FLAC · OGG · AIFF — hasta 200MB</div>
            <div style="display:flex;gap:.5rem;margin-top:1rem;flex-wrap:wrap;justify-content:center">
              <button class="btn btn-primary" id="mxrDropBtn">＋ Elegir archivos</button>
              <button class="btn btn-ref" id="mxrEmptyLibraryBtn">📚 Usar librería</button>
            </div>
          </div>`;
        document.getElementById('mxrDropBtn')?.addEventListener('click', () => {
          document.getElementById('mixerFileInput')?.click();
        });
      }
    }
    updateToolbarHeader();
    renderMixerSidePanel();
  }

  function renderMixerSidePanel() {
    const panel = getMixerSidePanel();
    if (!panel) return;
    const stemNames = Object.keys(mixerState.stems);
    panel.innerHTML = `
      <div class="mxr-side-section">
        <div class="mxr-side-label">Master Bus</div>
        <div class="param">
          <label>Ganancia</label>
          <span class="val" id="mix-master-gain-val">+0.0 dB</span>
          <input type="range" id="mix-master-gain" min="${FADER_MIN}" max="12" step="0.5" value="0">
        </div>
        <div class="param">
          <label>Target LUFS</label>
          <span class="val" id="mix-lufs-val">-14.0</span>
          <input type="range" id="mix-lufs" min="-24" max="-6" step="0.5" value="-14">
        </div>
        <label class="mxr-check-label">
          <input type="checkbox" id="mix-normalize" checked> Normalizar antes de masterizar
        </label>
      </div>
      <div class="mxr-side-section">
        <div class="mxr-side-label">Preview servidor (chain completo)</div>
        <label class="mxr-check-label">
          <input type="checkbox" id="mxrServerPreviewToggle" ${serverPreview.enabled?'checked':''}> Render real (con latencia)
        </label>
        <audio id="mxrServerPreviewAudio" controls style="width:100%;${serverPreview.enabled?'':'display:none'}"></audio>
        <div class="mxr-status" id="mxrServerPreviewStatus"></div>
      </div>
      <div class="mxr-side-section">
        <button class="btn btn-ref" id="mixerSubmitBtn" ${stemNames.length===0?'disabled':''} style="width:100%">
          🎛 Mezclar y masterizar
        </button>
        <div id="mixerStatus" class="mxr-status"></div>
      </div>
      <div class="mxr-side-section mxr-stem-library">
        <div class="mxr-side-label">Librería de stems</div>
        <div class="mxr-library-actions">
          <button class="btn btn-sm" id="mxrRefreshLibraryBtn">↻ Actualizar</button>
          <span class="mxr-status">Se guardan stems nuevos automáticamente</span>
        </div>
        ${mixerState.stemLibrary.length===0
          ? '<div style="color:var(--muted);font-size:.72rem">Sin stems guardados</div>'
          : mixerState.stemLibrary.slice(0, 8).map(item => `
            <div class="mxr-library-row">
              <button class="btn btn-xs mxr-library-add" data-library-id="${item.id}">＋</button>
              <span class="mxr-stems-name" title="${item.original_filename}">${item.original_filename}</span>
              <button class="mxr-library-del" data-library-id="${item.id}" title="Borrar de librería">✕</button>
            </div>`).join('')}
      </div>
      <div class="mxr-side-section mxr-stems-list">
        <div class="mxr-side-label">Stems (${stemNames.length})</div>
        ${stemNames.length===0
          ? '<div style="color:var(--muted);font-size:.72rem">Sin stems</div>'
          : stemNames.map(n => {
              const s = mixerState.stems[n];
              return `<div class="mxr-stems-row">
                <span>${stemEmoji(s.params.stem_type)}</span>
                <span class="mxr-stems-name" title="${n}">${n}</span>
                <span style="color:${s.uploaded?'var(--vu-green)':'var(--amber)'}">${s.uploaded?'✓':'⏳'}</span>
              </div>`;
            }).join('')}
      </div>
    `;

    document.getElementById('mix-master-gain')?.addEventListener('input', e => {
      const db = parseFloat(e.target.value);
      document.getElementById('mix-master-gain-val').textContent = formatDbValue(db);
      const lblCh = document.getElementById('mix-master-gain-val-ch');
      if (lblCh) lblCh.textContent = formatDbValue(db);
      setFaderDb('master', db);
      if (previewEngine.ctx) previewEngine.masterGain.gain.setTargetAtTime(dbToLin(db), previewEngine.ctx.currentTime, 0.015);
      scheduleServerPreview();
    });

    document.getElementById('mix-lufs')?.addEventListener('input', e => {
      document.getElementById('mix-lufs-val').textContent = parseFloat(e.target.value).toFixed(1);
      scheduleServerPreview();
    });

    document.getElementById('mix-normalize')?.addEventListener('change', scheduleServerPreview);
    document.getElementById('mixerSubmitBtn')?.addEventListener('click', submitMix);
    document.getElementById('mxrRefreshLibraryBtn')?.addEventListener('click', () => refreshStemLibrary(true));
    document.querySelectorAll('.mxr-library-add').forEach(btn => btn.addEventListener('click', () => {
      const item = mixerState.stemLibrary.find(x => x.id === btn.dataset.libraryId);
      if (item) addStemFromLibrary(item);
    }));
    document.querySelectorAll('.mxr-library-del').forEach(btn => btn.addEventListener('click', () => {
      const item = mixerState.stemLibrary.find(x => x.id === btn.dataset.libraryId);
      if (item) deleteStemFromLibrary(item);
    }));
    document.getElementById('mxrServerPreviewToggle')?.addEventListener('change', e => {
      serverPreview.enabled = e.target.checked;
      const audioEl = document.getElementById('mxrServerPreviewAudio');
      if (audioEl) audioEl.style.display = serverPreview.enabled ? 'block' : 'none';
      if (serverPreview.enabled) runServerPreview();
      else { setServerPreviewStatus(''); if (serverPreview.ws) { try { serverPreview.ws.close(); } catch (e2) {} } }
    });
  }

  function renderMasterChannel() {
    return `
      <div class="mxr-ch-header">
        <span class="mxr-ch-emoji">🔊</span>
        <span class="mxr-ch-name" style="color:var(--amber)">MASTER</span>
      </div>
      <div class="mxr-fader-area">
        <div class="mxr-db-scale">
          <span>+12</span><span>+6</span><span>0</span>
          <span>-6</span><span>-12</span><span>-∞</span>
        </div>
        ${faderHTML('master', 0)}
        <div class="mxr-fader-val" id="mix-master-gain-val-ch">+0.0 dB</div>
      </div>
      <div class="mxr-vu-wrap">
        <div class="mxr-vu-bar"><div class="mxr-vu-fill" id="mxr-vu-fill-l-master"></div></div>
        <div class="mxr-vu-bar"><div class="mxr-vu-fill" id="mxr-vu-fill-r-master"></div></div>
      </div>
    `;
  }

  function renderChannel(name) {
    const s = mixerState.stems[name];
    const p = s.params;
    const otherNames = Object.keys(mixerState.stems).filter(n => n !== name);
    const panLabel = Math.abs(p.pan) < 0.02 ? 'C' : (p.pan > 0 ? 'R' : 'L') + Math.abs(p.pan*100|0);

    return `
      <div class="mxr-channel ${p.mute?'mxr-ch--muted':''} ${p.solo?'mxr-ch--solo':''}"
           data-stem="${name}" id="ch-${CSS.escape(name)}">

        <div class="mxr-ch-header">
          <span class="mxr-ch-emoji">${stemEmoji(p.stem_type)}</span>
          <span class="mxr-ch-name" title="${name}">${name}</span>
          <button class="mxr-ch-close" data-stem="${name}">✕</button>
        </div>

        ${!s.uploaded ? `<div class="mxr-ch-uploading">⏳ Subiendo…</div>` : ''}

        <div class="mxr-fader-area">
          <div class="mxr-db-scale">
            <span>+12</span><span>+6</span><span>0</span>
            <span>-6</span><span>-12</span><span>-∞</span>
          </div>
          ${faderHTML('gain:'+name, p.gain_db)}
          <div class="mxr-fader-val" id="ch-gain-val-${name}">${formatDbValue(p.gain_db)}</div>
        </div>

        <div class="mxr-vu-wrap">
          <div class="mxr-vu-bar"><div class="mxr-vu-fill" id="mxr-vu-fill-l-${name}"></div></div>
          <div class="mxr-vu-bar"><div class="mxr-vu-fill" id="mxr-vu-fill-r-${name}"></div></div>
        </div>

        <div class="mxr-pan-row">
          <span class="mxr-pan-label">L</span>
          <input type="range" class="mxr-pan-slider" data-stem="${name}" data-param="pan"
            min="-1" max="1" step="0.05" value="${p.pan}">
          <span class="mxr-pan-label">R</span>
          <span class="mxr-pan-val" id="ch-pan-val-${name}">${panLabel}</span>
        </div>

        <div class="mxr-ms-row">
          <button class="mxr-btn-ms ${p.mute?'active-mute':''}" data-stem="${name}" data-action="mute">M</button>
          <button class="mxr-btn-ms ${p.solo?'active-solo':''}" data-stem="${name}" data-action="solo">S</button>
        </div>

        <details class="mxr-ch-details">
          <summary>⚙ Avanzado</summary>
          <div class="mxr-adv-section">Filtros</div>
          <div class="param"><label>HP</label>
            <span class="val" id="ch-hp-val-${name}">${p.hp_cutoff_hz} Hz</span>
            <input type="range" data-stem="${name}" data-param="hp_cutoff_hz" min="20" max="500" step="5" value="${p.hp_cutoff_hz}">
          </div>
          <div class="param"><label>LP</label>
            <span class="val" id="ch-lp-val-${name}">${p.lp_cutoff_hz>=20000?'20k':p.lp_cutoff_hz+' Hz'}</span>
            <input type="range" data-stem="${name}" data-param="lp_cutoff_hz" min="2000" max="20000" step="100" value="${p.lp_cutoff_hz}">
          </div>
          <div class="mxr-adv-section">EQ 4 bandas</div>
          ${renderEQBand(name,'low',  'Graves', p.eq_low_freq,   p.eq_low_gain_db,   p.eq_low_q)}
          ${renderEQBand(name,'lomid','L-Mid',  p.eq_lomid_freq, p.eq_lomid_gain_db, p.eq_lomid_q)}
          ${renderEQBand(name,'himid','H-Mid',  p.eq_himid_freq, p.eq_himid_gain_db, p.eq_himid_q)}
          ${renderEQBand(name,'high', 'Agudos', p.eq_high_freq,  p.eq_high_gain_db,  p.eq_high_q)}
          <div class="mxr-adv-section" style="display:flex;align-items:center;gap:.4rem">
            Compresor <input type="checkbox" data-stem="${name}" data-param="comp_enabled" ${p.comp_enabled?'checked':''}>
          </div>
          <div class="param"><label>Threshold</label>
            <span class="val" id="ch-comp-thr-val-${name}">${formatLinearThresholdToDb(p.comp_threshold)}</span>
            <input type="range" data-stem="${name}" data-param="comp_threshold" min="0.01" max="1" step="0.01" value="${p.comp_threshold}">
          </div>
          <div class="param"><label>Ratio</label>
            <span class="val" id="ch-comp-ratio-val-${name}">${p.comp_ratio}:1</span>
            <input type="range" data-stem="${name}" data-param="comp_ratio" min="1" max="20" step="0.5" value="${p.comp_ratio}">
          </div>
          <div class="param"><label>Attack</label>
            <span class="val" id="ch-comp-atk-val-${name}">${p.comp_attack_ms} ms</span>
            <input type="range" data-stem="${name}" data-param="comp_attack_ms" min="0.1" max="100" step="0.1" value="${p.comp_attack_ms}">
          </div>
          <div class="param"><label>Release</label>
            <span class="val" id="ch-comp-rel-val-${name}">${p.comp_release_ms} ms</span>
            <input type="range" data-stem="${name}" data-param="comp_release_ms" min="10" max="500" step="5" value="${p.comp_release_ms}">
          </div>
          <div class="param"><label>Makeup</label>
            <span class="val" id="ch-comp-mkp-val-${name}">${formatDbValue(p.comp_makeup_db)}</span>
            <input type="range" data-stem="${name}" data-param="comp_makeup_db" min="-6" max="24" step="0.5" value="${p.comp_makeup_db}">
          </div>
          <div class="mxr-adv-section">Transient</div>
          <div class="param"><label>Attack</label>
            <span class="val" id="ch-tr-atk-val-${name}">${p.transient_attack>0?'+':''}${p.transient_attack.toFixed(2)}</span>
            <input type="range" data-stem="${name}" data-param="transient_attack" min="-1" max="1" step="0.05" value="${p.transient_attack}">
          </div>
          <div class="param"><label>Sustain</label>
            <span class="val" id="ch-tr-sus-val-${name}">${p.transient_sustain>0?'+':''}${p.transient_sustain.toFixed(2)}</span>
            <input type="range" data-stem="${name}" data-param="transient_sustain" min="-1" max="1" step="0.05" value="${p.transient_sustain}">
          </div>
          <div class="param"><label>Stereo</label>
            <span class="val" id="ch-sw-val-${name}">${p.stereo_width_amount.toFixed(2)}</span>
            <input type="range" data-stem="${name}" data-param="stereo_width_amount" min="0" max="2" step="0.05" value="${p.stereo_width_amount}">
          </div>
          <div class="mxr-adv-section">Sidechain</div>
          <div style="font-size:.7rem;margin:.15rem 0">
            <label style="display:block;margin-bottom:.15rem">Trigger</label>
            <select data-stem="${name}" data-param="sidechain_trigger_name"
              style="width:100%;font-size:.68rem;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:3px;padding:.2rem">
              <option value="">— Desactivado —</option>
              ${otherNames.map(n=>`<option value="${n}" ${p.sidechain_trigger_name===n?'selected':''}>${n}</option>`).join('')}
            </select>
          </div>
          <div class="param"><label>SC Threshold</label>
            <span class="val" id="ch-sc-thr-val-${name}">${formatLinearThresholdToDb(p.sidechain_threshold)}</span>
            <input type="range" data-stem="${name}" data-param="sidechain_threshold" min="0.01" max="1" step="0.01" value="${p.sidechain_threshold}">
          </div>
          <div class="param"><label>SC Ratio</label>
            <span class="val" id="ch-sc-ratio-val-${name}">${p.sidechain_ratio}:1</span>
            <input type="range" data-stem="${name}" data-param="sidechain_ratio" min="1" max="20" step="0.5" value="${p.sidechain_ratio}">
          </div>
        </details>
      </div>
    `;
  }

  function renderEQBand(stemName, band, label, freq, gain, q) {
    return `
      <div class="mxr-eqband">
        <div class="mxr-eqband-label">${label}</div>
        <div class="mxr-eqband-row">
          <span class="mxr-eqband-tag">Frec.</span>
          <input type="range" data-stem="${stemName}" data-param="eq_${band}_freq"
            min="${band==='low'?40:band==='lomid'?200:band==='himid'?800:4000}"
            max="${band==='low'?400:band==='lomid'?1500:band==='himid'?8000:18000}"
            step="10" value="${freq}">
          <span class="mxr-eqband-val" id="ch-eq-${band}-freq-val-${stemName}">${freq>=1000?(freq/1000).toFixed(1)+'k':freq}Hz</span>
        </div>
        <div class="mxr-eqband-row">
          <span class="mxr-eqband-tag">Gan.</span>
          <input type="range" data-stem="${stemName}" data-param="eq_${band}_gain_db" min="-12" max="12" step="0.5" value="${gain}">
          <span class="mxr-eqband-val" id="ch-eq-${band}-gain-val-${stemName}">${formatDbValue(gain)}</span>
        </div>
        <div class="mxr-eqband-row">
          <span class="mxr-eqband-tag">Q</span>
          <input type="range" data-stem="${stemName}" data-param="eq_${band}_q" min="0.3" max="4" step="0.1" value="${q}">
          <span class="mxr-eqband-val" id="ch-eq-${band}-q-val-${stemName}">${q.toFixed(1)}</span>
        </div>
      </div>`;
  }

  // ── Events ────────────────────────────────────────────────────────────────
  function bindMixerEvents() {
    const area = getMixerContentArea();
    if (!area || area._mixerBound) return;
    area._mixerBound = true;

    area.addEventListener('click', e => {
      if (e.target.closest('#mixerAddStemBtn') || e.target.closest('#mxrDropBtn')) {
        document.getElementById('mixerFileInput')?.click(); return;
      }
      if (e.target.closest('#mixerAddMultiBtn')) {
        document.getElementById('mixerMultiInput')?.click(); return;
      }
      if (e.target.closest('#mixerLibraryBtn') || e.target.closest('#mxrEmptyLibraryBtn')) {
        refreshStemLibrary(true); return;
      }
      if (e.target.closest('#mixerClearBtn')) {
        if (!Object.keys(mixerState.stems).length || confirm('¿Limpiar todos los stems?')) {
          resetPreviewEngine();
          mixerState.stems = {}; mixerState.sessionId = getGenUUID(); renderMixer();
        }
        return;
      }
      if (e.target.closest('#mxrPlayBtn')) { togglePreview(); return; }
    });

    document.addEventListener('change', e => {
      if (e.target.id === 'mixerFileInput') {
        if (e.target.files[0]) handleStemFile(e.target.files[0]);
        e.target.value = '';
      }
      if (e.target.id === 'mixerMultiInput') {
        Array.from(e.target.files).forEach(f => handleStemFile(f));
        e.target.value = '';
      }
    });

    area.addEventListener('dragover', e => {
      e.preventDefault();
      document.getElementById('mxrStage')?.classList.add('mxr-drag');
    });
    area.addEventListener('dragleave', e => {
      if (!area.contains(e.relatedTarget))
        document.getElementById('mxrStage')?.classList.remove('mxr-drag');
    });
    area.addEventListener('drop', e => {
      e.preventDefault();
      document.getElementById('mxrStage')?.classList.remove('mxr-drag');
      Array.from(e.dataTransfer.files).forEach(f => handleStemFile(f));
    });

    area.addEventListener('input',  onChannelInput);
    area.addEventListener('change', onChannelChange);
    area.addEventListener('click',  onChannelClick);
  }

  function onChannelInput(e) {
    const el = e.target;
    if (el.id === 'mxrSeek') { seekPreview(parseFloat(el.value) || 0); return; }
    const stemName = el.dataset.stem, param = el.dataset.param;
    if (!stemName || !param) return;
    const p = mixerState.stems[stemName]?.params;
    if (!p) return;
    const val = el.type === 'checkbox' ? el.checked : parseFloat(el.value);
    p[param] = val;
    const valEl = document.getElementById(`ch-${paramToValId(param)}-val-${stemName}`);
    if (valEl) valEl.textContent = formatParamValue(param, val);
    if (previewEngine.nodes[stemName]) applyStemParamsToChain(stemName);
    scheduleServerPreview();
  }

  function onChannelChange(e) {
    const el = e.target;
    const stemName = el.dataset.stem, param = el.dataset.param;
    if (!stemName || !param || el.tagName !== 'SELECT') return;
    const p = mixerState.stems[stemName]?.params;
    if (p) p[param] = el.value || null;
    scheduleServerPreview();
  }

  function onChannelClick(e) {
    const close = e.target.closest('.mxr-ch-close');
    if (close) {
      const n = close.dataset.stem;
      removeStemFromPreview(n);
      delete mixerState.stems[n];
      removeChannelFromDOM(n);
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const name = btn.dataset.stem, action = btn.dataset.action;
      const p = mixerState.stems[name]?.params;
      if (!p) return;
      if (action === 'mute') {
        p.mute = !p.mute;
        btn.classList.toggle('active-mute', p.mute);
        document.getElementById(`ch-${CSS.escape(name)}`)?.classList.toggle('mxr-ch--muted', p.mute);
      }
      if (action === 'solo') {
        p.solo = !p.solo;
        btn.classList.toggle('active-solo', p.solo);
        document.getElementById(`ch-${CSS.escape(name)}`)?.classList.toggle('mxr-ch--solo', p.solo);
      }
      updateAllMuteSolo();
    }
  }

  function paramToValId(param) {
    const eqMatch = param.match(/^eq_(low|lomid|himid|high)_(freq|q|gain_db)$/);
    if (eqMatch) {
      const band = eqMatch[1], metric = eqMatch[2];
      return metric === 'gain_db' ? `eq-${band}-gain` : `eq-${band}-${metric}`;
    }
    const map = {
      gain_db:'gain',pan:'pan',hp_cutoff_hz:'hp',lp_cutoff_hz:'lp',
      comp_threshold:'comp-thr',comp_ratio:'comp-ratio',
      comp_attack_ms:'comp-atk',comp_release_ms:'comp-rel',comp_makeup_db:'comp-mkp',
      transient_attack:'tr-atk',transient_sustain:'tr-sus',
      stereo_width_amount:'sw',sidechain_threshold:'sc-thr',sidechain_ratio:'sc-ratio',
    };
    return map[param] || param.replace(/_/g,'-');
  }

  function formatParamValue(param, val) {
    if (param==='pan') { if (Math.abs(val)<0.02) return 'C'; return (val>0?'R':'L')+Math.abs(val*100|0); }
    if (param.includes('gain_db')||param.includes('makeup_db')) return formatDbValue(val);
    if (param.includes('threshold')) return formatLinearThresholdToDb(val);
    if (param.includes('ratio')) return val+':1';
    if (param.includes('_ms')) return val+' ms';
    if (param.includes('_hz')||param.includes('_freq')) return val>=1000?(val/1000).toFixed(1)+' kHz':val+' Hz';
    return parseFloat(val).toFixed(2);
  }

  // ── Upload ────────────────────────────────────────────────────────────────
  async function handleStemFile(file) {
    if (!/\.(wav|mp3|flac|ogg|aiff|aif)$/i.test(file.name)) { alert(`Formato no soportado: ${file.name}`); return; }
    if (file.size > 200*1024*1024) { alert(`${file.name} supera 200MB.`); return; }
    const stemName = file.name.replace(/\.[^.]+$/,'');
    if (mixerState.stems[stemName] && !confirm(`Ya existe "${stemName}". ¿Reemplazar?`)) return;
    mixerState.stems[stemName] = { file, params: defaultStemParams(stemName), uploaded: false, duration: null };
    addChannelToDOM(stemName);
    decodeStemForPreview(stemName, file);
    try {
      const fd = new FormData();
      fd.append('file', file); fd.append('session_id', mixerState.sessionId); fd.append('stem_name', stemName); fd.append('save_to_library', 'true');
      const res = await fetch(`${getAPI()}/mix/upload-stem`, { method:'POST', body:fd });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      mixerState.stems[stemName].uploaded = true;
      mixerState.stems[stemName].duration = data.duration_sec;
      if (data.library_item) {
        mixerState.stems[stemName].libraryId = data.library_item.id;
        mixerState.stemLibraryLoaded = false;
        refreshStemLibrary(true);
      }
      document.querySelector(`#ch-${CSS.escape(stemName)} .mxr-ch-uploading`)?.remove();
      renderMixerSidePanel();
      document.getElementById('mixerSubmitBtn')?.removeAttribute('disabled');
      scheduleServerPreview();
    } catch(err) {
      const el = document.querySelector(`#ch-${CSS.escape(stemName)} .mxr-ch-uploading`);
      if (el) el.textContent = '❌ Error al subir';
    }
  }

  // ── Submit & poll ──────────────────────────────────────────────────────────
  async function submitMix() {
    const stemNames = Object.keys(mixerState.stems);
    if (!stemNames.length) return;
    const notUp = stemNames.filter(n => !mixerState.stems[n].uploaded);
    if (notUp.length) { alert(`Esperá que terminen: ${notUp.join(', ')}`); return; }

    const statusEl = document.getElementById('mixerStatus');
    const btn = document.getElementById('mixerSubmitBtn');
    btn.disabled = true; 
    statusEl.textContent = 'Iniciando mezcla…';

    const stemParams = {};
    for (const n of stemNames) stemParams[n] = mixerState.stems[n].params;

    const mixParams = {
      master_gain_db: parseFloat(document.getElementById('mix-master-gain')?.value || 0),
      target_lufs:    parseFloat(document.getElementById('mix-lufs')?.value || -14),
      normalize_before_master: document.getElementById('mix-normalize')?.checked ?? true,
      chain_params: {},
    };

    try {
      const fd = new FormData();
      fd.append('session_id', mixerState.sessionId);
      fd.append('stem_names',  JSON.stringify(stemNames));
      fd.append('stem_params', JSON.stringify(stemParams));
      fd.append('mix_params',  JSON.stringify(mixParams));
      fd.append('stem_library_ids', JSON.stringify(buildStemLibraryIdMap(stemNames)));

      const res = await fetch(`${getAPI()}/mix/submit`, { method: 'POST', body: fd });
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText || `Error del servidor (${res.status})`);
      }

      const data = await res.json();
      const jobId = data.job_id || data.jobId;

      if (!jobId) throw new Error('El servidor no devolvió un ID de trabajo válido.');

      mixerState.jobId = jobId;
      statusEl.textContent = 'Job iniciado…';
      pollMixJob(jobId, btn, statusEl);

    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      btn.disabled = false;
    }
  }

  function pollMixJob(jobId, btn, statusEl) {
    if (mixerState.polling) {
      clearInterval(mixerState.polling);
      mixerState.polling = null;
    }

    mixerState.polling = setInterval(async () => {
      try {
        const res = await fetch(`${getAPI()}/job/${jobId}`);
        if (!res.ok) {
          throw new Error(`Error en el servidor al consultar trabajo (${res.status})`);
        }

        const data = await res.json();
        const stageText = data.stage || data.status || 'Procesando';
        const progressText = data.progress != null ? `${data.progress}%` : '';
        statusEl.textContent = `${stageText} ${progressText}`.trim();

        if (data.status === 'done' || data.status === 'completed') {
          clearInterval(mixerState.polling);
          mixerState.polling = null;
          btn.disabled = false;
          onMixDone(jobId, data);
        } else if (data.status === 'error' || data.status === 'failed') {
          clearInterval(mixerState.polling);
          mixerState.polling = null;
          btn.disabled = false;
          statusEl.textContent = `Error: ${data.error || 'Proceso fallido'}`;
        }
      } catch (err) {
        console.warn('Error durante polling del job:', err);
      }
    }, 1500);
  }

  function onMixDone(jobId, data) {
    const statusEl = document.getElementById('mixerStatus');
    const result = data.result || {};
    statusEl.innerHTML = `✅ Mix listo — LUFS: <b>${result.lufs ?? '--'}</b> | Peak: <b>${result.peak_db ?? '--'} dBFS</b><br>
      <a href="${getAPI()}/download/${jobId}" class="btn btn-sm" style="margin-top:.4rem;display:inline-block">⬇ Descargar mix</a>`;
    if (result.stem_meters) {
      for (const [name, m] of Object.entries(result.stem_meters)) {
        ['l','r'].forEach(ch => {
          const fill = document.getElementById(`mxr-vu-fill-${ch}-${name}`);
          if (fill && m.peak_db != null) {
            const pct = Math.max(0, Math.min(100, (m.peak_db + 60) / 60 * 100));
            fill.style.height = pct + '%';
            fill.style.background = m.peak_db > -3 ? 'var(--clip-red)' : m.peak_db > -12 ? 'var(--amber)' : 'var(--vu-green)';
          }
        });
      }
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    const tabs = document.getElementById('sidebarTabs');
    if (tabs && !document.querySelector('[data-pane="pane-mixer"]')) {
      const tab = document.createElement('button');
      tab.className = 'sidebar-tab';
      tab.dataset.pane = 'pane-mixer';
      tab.textContent = '🎚 Mixer';
      tabs.appendChild(tab);
    }

    const container = document.getElementById('sidebarPaneContainer');
    if (container && !document.getElementById('pasoMixer')) {
      const pane = document.createElement('div');
      pane.className = 'sidebar-pane-mixer';
      pane.id = 'pasoMixer';
      pane.innerHTML = `<div id="mixerSidePanel" class="mxr-side-panel"></div>`;
      container.querySelector('.control-stack')?.appendChild(pane);
    }

    const contentShell = document.querySelector('.content-shell');
    if (contentShell && !document.getElementById('mixerContentArea')) {
      const area = document.createElement('div');
      area.id = 'mixerContentArea';
      area.className = 'mxr-content-area';
      area.style.display = 'none';
      contentShell.appendChild(area);
    }

    document.querySelectorAll('#sidebarTabs .sidebar-tab').forEach(tab => {
      if (tab.dataset.pane === 'pane-mixer') {
        tab.addEventListener('click', activateMixerMode);
      } else {
        tab.addEventListener('click', deactivateMixerMode);
      }
    });

    injectMixerCSS();
  }

  function activateMixerMode() {
    const shell  = document.querySelector('.content-shell');
    const mixArea = document.getElementById('mixerContentArea');
    const cont   = document.getElementById('sidebarPaneContainer');
    if (cont) {
      cont.className = cont.className.replace(/sidebar-showing-\w+/g,'').trim();
      cont.classList.add('sidebar-showing-mixer');
    }
    shell?.querySelectorAll(':scope>*:not(#mixerContentArea)').forEach(el => {
      el._pd = el.style.display; el.style.display='none';
    });
    if (mixArea) {
      mixArea.style.display = 'flex';
      if (!mixArea.firstChild) renderMixer();
      bindMixerEvents();
      refreshStemLibrary(false);
    }
    document.querySelector('.content')?.classList.add('content--mixer');
    document.body.classList.add('mode-mixer');
  }

  function deactivateMixerMode() {
    const shell  = document.querySelector('.content-shell');
    const mixArea = document.getElementById('mixerContentArea');
    shell?.querySelectorAll(':scope>*:not(#mixerContentArea)').forEach(el => {
      el.style.display = el._pd !== undefined ? el._pd : '';
    });
    if (mixArea) mixArea.style.display='none';
    document.querySelector('.content')?.classList.remove('content--mixer');
    document.body.classList.remove('mode-mixer');
    if (previewEngine.playing) stopPreview(false);
  }

  function injectMixerCSS() {
    if (document.getElementById('mixer-v4-style')) return;
    const s = document.createElement('style');
    s.id = 'mixer-v4-style';
    s.textContent = `
      /* ── Sidebar pane ── */
      .sidebar-pane-mixer { display:none; }
      .sidebar-showing-mixer .sidebar-pane-archivo,
      .sidebar-showing-mixer .sidebar-pane-cadena,
      .sidebar-showing-mixer .sidebar-pane-salida { display:none !important; }
      .sidebar-showing-mixer .sidebar-pane-mixer  { display:block !important; }

      .mxr-side-panel { display:flex;flex-direction:column;gap:.5rem;padding:.1rem 0; }
      .mxr-side-section {
        background:var(--surface2);border:1px solid var(--border);
        border-radius:8px;padding:.5rem .55rem;
        display:flex;flex-direction:column;gap:.3rem;
      }
      .mxr-side-label {
        font-family:var(--mono);font-size:.58rem;letter-spacing:.1em;
        text-transform:uppercase;color:var(--amber);
      }
      .mxr-check-label { display:flex;align-items:center;gap:.4rem;font-size:.74rem;cursor:pointer; }
      .mxr-status { font-size:.7rem;color:var(--muted);min-height:.9rem;line-height:1.4; }
      .mxr-stems-list { gap:.2rem; }
      .mxr-stems-row { display:flex;align-items:center;gap:.3rem;font-size:.7rem;padding:.1rem 0;border-bottom:1px solid var(--border2); }
      .mxr-stems-name { flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      .mxr-library-actions { display:flex;align-items:center;gap:.35rem;flex-wrap:wrap; }
      .mxr-library-row { display:flex;align-items:center;gap:.3rem;font-size:.7rem;padding:.14rem 0;border-bottom:1px solid var(--border2); }
      .mxr-library-add { padding:.08rem .3rem;line-height:1; }
      .mxr-library-del { background:none;border:none;color:var(--faint);cursor:pointer;padding:0 .15rem; }
      .mxr-library-del:hover { color:var(--clip-red); }

      /* ── body.mode-mixer: content fills all space ── */
      body.mode-mixer .content { flex:1;overflow:hidden;display:flex;flex-direction:column; }
      body.mode-mixer .content-shell { max-width:none;flex:1;min-height:0;display:flex;flex-direction:column;padding:0;margin:0; }
      body.mode-mixer #mixerContentArea { flex:1;min-height:0; }

      /* ── Mixer content area ── */
      .mxr-content-area {
        display:flex;flex-direction:column;
        flex:1;min-height:0;height:100%;
      }

      /* ── Toolbar ── */
      .mxr-toolbar {
        display:flex;align-items:center;gap:.4rem;flex-wrap:nowrap;
        padding:.3rem .4rem;background:var(--surface2);
        border-bottom:1px solid var(--border);flex-shrink:0;
      }
      .mxr-title-tag { font-family:var(--mono);font-size:.62rem;color:var(--muted); }
      .mxr-clear-btn { color:var(--muted);margin-left:auto; }
      .mxr-transport { display:flex;align-items:center;gap:.4rem;flex:1;justify-content:center;min-width:0; }
      .mxr-transport #mxrPlayBtn { flex-shrink:0;min-width:2rem; }
      .mxr-seek { flex:1;max-width:320px;accent-color:var(--amber); }
      .mxr-time { font-family:var(--mono);font-size:.62rem;color:var(--muted);flex-shrink:0;white-space:nowrap; }

      /* ── Stage ── */
      .mxr-stage {
        flex:1;min-height:0;display:flex;overflow:hidden;
        background:var(--bg);
      }
      .mxr-stage.mxr-drag { box-shadow:inset 0 0 0 2px var(--amber); }

      /* ── Empty state ── */
      .mxr-empty {
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        flex:1;color:var(--muted);text-align:center;padding:2rem;
        border:2px dashed var(--border);border-radius:8px;margin:.5rem;
      }
      .mxr-empty-icon  { font-size:2.5rem;margin-bottom:.6rem;opacity:.5; }
      .mxr-empty-title { font-size:.95rem;font-weight:600;margin-bottom:.2rem; }
      .mxr-empty-sub   { font-size:.72rem;opacity:.6; }

      /* ── Channels strip ── */
      .mxr-channels {
        display:flex;flex:1;min-width:0;height:100%;
        overflow-x:auto;overflow-y:hidden;
        scrollbar-width:thin;scrollbar-color:var(--border) transparent;
        gap:0;
      }

      /* ── Single channel ── */
      .mxr-channel {
        flex:1;
        min-width:168px;max-width:260px;
        display:flex;flex-direction:column;
        background:var(--surface);
        border-right:1px solid rgba(255,255,255,.06);
        padding:.5rem .45rem .4rem;
        overflow-y:auto;overflow-x:hidden;
        scrollbar-width:thin;
        box-sizing:border-box;
        transition:background .12s,opacity .18s;
      }
      .mxr-channel:hover   { background:var(--surface2); }
      .mxr-channel--muted  { opacity:.28; }
      .mxr-channel--solo   { background:rgba(167,139,250,.08) !important; }
      .mxr-master-ch {
        min-width:150px;max-width:200px;
        background:linear-gradient(180deg,rgba(240,184,64,.07),var(--surface));
        border-left:2px solid rgba(240,184,64,.3);border-right:none;
      }

      /* ── Header ── */
      .mxr-ch-header {
        display:flex;align-items:center;gap:.15rem;
        padding-bottom:.2rem;margin-bottom:.15rem;
        border-bottom:1px solid rgba(255,255,255,.05);flex-shrink:0;
      }
      .mxr-ch-emoji { font-size:1rem;flex-shrink:0; }
      .mxr-ch-name  { flex:1;font-size:.74rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--mono);color:var(--text); }
      .mxr-ch-close { background:none;border:none;cursor:pointer;color:var(--faint);font-size:.85rem;padding:0 .15rem;line-height:1;flex-shrink:0; }
      .mxr-ch-close:hover { color:var(--clip-red); }
      .mxr-ch-uploading { font-size:.72rem;color:var(--amber);padding:.1rem 0;flex-shrink:0; }

      /* ── Fader area ── */
      .mxr-fader-area {
        flex:1;min-height:0;
        display:flex;flex-direction:row;align-items:stretch;justify-content:center;
        gap:.4rem;padding:.1rem 0;
        position:relative;
      }

      .mxr-db-scale {
        display:flex;flex-direction:column;justify-content:space-between;
        align-items:flex-end;flex-shrink:0;width:26px;padding:.1rem 0;
        font-family:var(--mono);font-size:.6rem;color:var(--faint);
        line-height:1;pointer-events:none;user-select:none;
      }

      /* ── CSS fader ── */
      .mxr-fader-css {
        flex:0 0 auto;
        width:36px;max-width:36px;
        position:relative;
        display:flex;flex-direction:column;
        align-items:center;justify-content:stretch;
        cursor:ns-resize;touch-action:none;
        min-height:80px;
        outline:none;
      }
      .mxr-fader-track {
        position:relative;
        flex:1;width:100%;
        display:flex;align-items:center;justify-content:center;
      }
      .mxr-fader-track::before {
        content:'';
        position:absolute;
        left:50%;transform:translateX(-50%);
        width:3px;top:0;bottom:0;
        background:rgba(255,255,255,.1);
        border-radius:2px;
      }
      .mxr-fader-fill {
        position:absolute;
        left:50%;transform:translateX(-50%);
        width:3px;
        bottom:0;
        height:var(--fill-h, 50%);
        background:var(--amber);opacity:.45;
        border-radius:2px;
        pointer-events:none;
      }
      .mxr-fader-zero {
        position:absolute;
        left:50%;transform:translateX(-50%);
        width:10px;height:1px;
        top:var(--zero-top, 83%);
        background:rgba(255,255,255,.25);
        pointer-events:none;
      }
      .mxr-fader-knob {
        position:absolute;
        left:50%;transform:translate(-50%, -50%);
        top:var(--knob-top, 50%);
        width:calc(100% - 4px);
        min-width:24px;
        height:22px;
        background:var(--surface3);
        border:1.5px solid var(--amber);
        border-radius:3px;
        box-shadow:0 2px 6px rgba(0,0,0,.5);
        pointer-events:none;
        transition:border-color .1s;
      }
      .mxr-fader-knob::after {
        content:'';
        position:absolute;
        left:20%;right:20%;
        top:50%;transform:translateY(-50%);
        height:1.5px;background:var(--amber);opacity:.7;border-radius:1px;
      }
      .mxr-fader-css:hover .mxr-fader-knob { border-color:#ffe080; }
      .mxr-fader-css:focus .mxr-fader-knob { border-color:var(--cyan);box-shadow:0 0 0 2px rgba(34,211,238,.25); }

      .mxr-fader-val {
        font-family:var(--mono);font-size:.72rem;color:var(--amber);
        text-align:center;flex-shrink:0;padding:.15rem 0;
        white-space:nowrap;align-self:center;
      }

      /* ── VU meters ── */
      .mxr-vu-wrap {
        display:flex;gap:3px;justify-content:center;flex-shrink:0;margin:.15rem 0;
      }
      .mxr-vu-bar {
        width:6px;height:36px;
        background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden;position:relative;
      }
      .mxr-vu-fill {
        position:absolute;bottom:0;left:0;right:0;
        height:0%;background:var(--vu-green);
        transition:height .07s,background .09s;border-radius:2px;
      }

      /* ── Pan ── */
      .mxr-pan-row {
        display:flex;align-items:center;gap:.15rem;flex-shrink:0;margin:.1rem 0;
      }
      .mxr-pan-label { font-size:.65rem;color:var(--faint);flex-shrink:0; }
      .mxr-pan-slider { flex:1;accent-color:var(--cyan);cursor:pointer;min-width:0; }
      .mxr-pan-val { font-family:var(--mono);font-size:.68rem;color:var(--cyan);min-width:2.1rem;text-align:right;flex-shrink:0; }

      /* ── M/S ── */
      .mxr-ms-row { display:flex;gap:.3rem;flex-shrink:0;margin:.2rem 0;justify-content:center; }
      .mxr-btn-ms {
        flex:1;background:var(--surface2);border:1px solid var(--border);
        border-radius:4px;padding:.25rem .3rem;cursor:pointer;
        font-size:.72rem;font-weight:700;color:var(--muted);
        transition:all .1s;font-family:var(--mono);
      }
      .mxr-btn-ms:hover { border-color:var(--text);color:var(--text); }
      .mxr-btn-ms.active-mute { background:var(--clip-red);color:#fff;border-color:var(--clip-red); }
      .mxr-btn-ms.active-solo { background:var(--amber);color:#000;border-color:var(--amber); }

      /* ── Avanzado ── */
      .mxr-ch-details { flex-shrink:0;margin-top:.3rem; }
      .mxr-ch-details>summary {
        font-size:.72rem;color:var(--muted);cursor:pointer;
        padding:.25rem 0;user-select:none;list-style:none;
      }
      .mxr-ch-details>summary::-webkit-details-marker { display:none; }
      .mxr-adv-section { font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:.45rem 0 .2rem;font-weight:600; }

      /* ── EQ 4 bandas ── */
      .mxr-eqband { margin-bottom:.5rem;padding-bottom:.3rem;border-bottom:1px solid var(--border2); }
      .mxr-eqband:last-of-type { border-bottom:none; }
      .mxr-eqband-label { font-size:.74rem;font-weight:700;color:var(--amber);margin-bottom:.15rem; }
      .mxr-eqband-row { display:flex;align-items:center;gap:.4rem;margin:.15rem 0; }
      .mxr-eqband-tag { font-size:.68rem;color:var(--muted);flex:0 0 2.6rem; }
      .mxr-eqband-row input[type="range"] { flex:1 1 auto;min-width:0;height:6px; }
      .mxr-eqband-val { font-size:.7rem;font-family:var(--mono);color:var(--text);flex:0 0 3.4rem;text-align:right; }

      /* ── Filas de parámetros dentro de "Avanzado" ── */
      .mxr-ch-details .param { display:flex;flex-wrap:wrap;align-items:center;gap:.2rem .35rem;margin:.3rem 0; }
      .mxr-ch-details .param label { font-size:.72rem;color:var(--muted);flex:1 0 auto;min-width:3.6rem; }
      .mxr-ch-details .param .val { font-size:.72rem;color:var(--text);font-family:var(--mono);white-space:nowrap; }
      .mxr-ch-details .param input[type="range"] { flex:1 1 100%;height:6px; }

      @media (max-width:540px) {
        .mxr-channel { min-width:150px;padding:.4rem .35rem; }
      }
    `;
    document.head.appendChild(s);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();