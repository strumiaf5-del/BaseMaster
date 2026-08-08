// ============================================================
// 07-mastering-actions.js — Master, Auto-Mastering IA, Analyze, Advice, Spectrum, Stems, Polling
// ============================================================
      // ── Analysis / Mastering / etc ──────────────────────────────────────────────
      function getContent() {
        return document.getElementById("content");
      }
      function clearResults() {
        const c = getContent();
        c.querySelectorAll(
          ".status-bar,.analysis-grid,.spectrum-wrap,.fft-wrap,.advice-panel,.ab-wrap,.loudness-meter,.professional-meter,.waveform-wrap,.ref-match-panel,.stems-wrap",
        ).forEach((el) => el.remove());
      }
      function showStatus(id, text, state, progress, stage) {
        let bar = document.getElementById("statusBar");
        if (!bar) {
          bar = document.createElement("div");
          bar.className = "status-bar";
          bar.id = "statusBar";
          bar.innerHTML = `
      <div class="status-bar-top">
        <div class="status-dot" id="statusDot"></div>
        <span class="status-text" id="statusText"></span>
        <span class="progress-pct" id="progressPct"></span>
        <span class="status-time" id="statusTime"></span>
      </div>
      <div class="progress-wrap" id="progressWrap"><div class="progress-bar" id="progressBar"></div></div>`;
          getContent().prepend(bar);
        }
        const active = state === "processing" || state === "queued";
        document.getElementById("statusDot").className = "status-dot " + state;
        document.getElementById("statusText").textContent = stage ? `${text} — ${stage}` : text;

        const wrap = document.getElementById("progressWrap");
        const pbar = document.getElementById("progressBar");
        const pct = document.getElementById("progressPct");
        wrap.style.display = active ? "block" : "none";

        if (active && typeof progress === "number" && !isNaN(progress)) {
          // Progreso real reportado por el backend (etapa a etapa de la cadena DSP).
          pbar.classList.remove("indeterminate");
          pbar.style.width = Math.max(0, Math.min(100, progress)) + "%";
          pct.textContent = Math.round(progress) + "%";
        } else if (active) {
          // Todavía sin dato de progreso (por ejemplo justo al encolar el job).
          pbar.classList.add("indeterminate");
          pbar.style.width = "";
          pct.textContent = "";
        } else {
          pbar.classList.remove("indeterminate");
          pct.textContent = "";
        }
      }

      // ── MASTER (corregido) ──────────────────────────────────────────────────────
      async function submitMasterJob() {
        clearResults();
        showStatus(null, "Enviando archivo…", "queued");
        document.getElementById("btnMaster").disabled = true;

        const fd = new FormData();
        // Si el archivo vino de la librería del servidor, mandamos library_id
        // en vez de volver a subir los bytes — el backend lo lee directo de
        // su disco. Si es un archivo local nuevo, se sube como siempre.
        if (_previewLibraryId) {
          fd.append("library_id", _previewLibraryId);
        } else {
          fd.append("file", selectedFile);
        }

        try {
          const params = buildParams();
          const url = `${API()}/master?${params.toString()}`;
          console.log("📤 Enviando a:", url);
          console.log("📁 Archivo:", selectedFile.name, selectedFile.size, "bytes");
          const res = await fetch(url, { method: "POST", body: fd });
          console.log("📥 Respuesta:", res.status, res.statusText);
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          currentJobId = data.job_id;
          showStatus(null, `Job ${currentJobId.slice(0, 8)}… en cola`, "queued");
          startPolling(currentJobId);
        } catch (e) {
          console.error("❌ Error al enviar:", e);
          showStatus(null, "Error: " + e.message, "error");
          document.getElementById("btnMaster").disabled = false;
        }
      }

      document.getElementById("btnMaster").addEventListener("click", () => {
        if (!selectedFile) {
          showStatus(null, "Selecciona un archivo primero", "error");
          return;
        }
        clearResults();
        const paramsObj = collectMasterParamsObj();
        renderParamsPreview(paramsObj, { onConfirm: submitMasterJob });
      });

      // Master (enqueue) from Paso 1 — reuses existing submitMasterJob flow
      document.getElementById("btnMasterAsync").addEventListener("click", () => {
        document.getElementById("btnMaster").click();
      });

      // Master (sync) — immediate processing and download
      async function submitMasterSync() {
        if (!selectedFile) {
          showStatus(null, "Selecciona un archivo primero", "error");
          return;
        }
        clearResults();
        showStatus(null, "Procesando (sync)…", "processing");
        const fd = new FormData();
        if (_previewLibraryId) fd.append("library_id", _previewLibraryId);
        else fd.append("file", selectedFile);
        try {
          const params = buildParams();
          const url = `${API()}/master/sync?${params.toString()}`;
          const res = await fetch(url, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const blob = await res.blob();
          let filename = "mastered.wav";
          const cd = res.headers.get("content-disposition");
          if (cd) {
            const m = cd.match(/filename\*=UTF-8''([^;]+)/) || cd.match(/filename=\"?([^\";]+)\"?/);
            if (m) filename = decodeURIComponent(m[1]);
          }
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          link.remove();
          showStatus(null, "Master sync completado ✓", "done");
        } catch (e) {
          console.error("Error en master sync:", e);
          showStatus(null, "Error: " + e.message, "error");
        }
      }

      document.getElementById("btnMasterSync").addEventListener("click", async () => {
        if (!selectedFile) {
          showStatus(null, "Selecciona un archivo primero", "error");
          return;
        }
        clearResults();
        const paramsObj = collectMasterParamsObj();
        renderParamsPreview(paramsObj, { onConfirm: submitMasterSync, confirmLabel: "Master (descarga)" });
      });

      // ── AUTO-MASTERING IA (la IA decide todo y encola el job) ───────────────────
      document.getElementById("btnAutoMaster").addEventListener("click", async () => {
        if (!selectedFile) {
          showStatus(null, "Selecciona un archivo primero", "error");
          return;
        }
        clearResults();
        showStatus(null, "🤖 La IA está analizando tu track…", "processing");
        const autoBtn = document.getElementById("btnAutoMaster");
        const masterBtn = document.getElementById("btnMaster");
        autoBtn.disabled = true;
        masterBtn.disabled = true;

        // Abrimos el panel del asistente para mostrar en vivo qué está decidiendo.
        const panel = aiEl("aiPanel");
        if (!panel.classList.contains("open")) panel.classList.add("open");
        aiEl("aiSuggestions").innerHTML = "";
        aiShowTyping();

        const fd = new FormData();
        fd.append("file", selectedFile);
        try {
          const fmt = document.getElementById("s-format") ? document.getElementById("s-format").value : "wav";
          const params = new URLSearchParams({ output_format: fmt });
          const res = await fetch(`${API()}/ai/auto-master?${params}`, { method: "POST", body: fd });
          aiHideTyping();
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          currentJobId = data.job_id;
          setAiContext(data.analysis);

          const d = data.ai_decision || {};
          const platformLabel = d.platform ? d.platform : "sin target específico";
          aiAppendMessage(
            "assistant",
            `🤖 Auto-Mastering en marcha — la IA calculó los parámetros a medida de este track (no usó un preset fijo).\nPlataforma: ${platformLabel}` +
              (d.reasoning ? `\n\n${d.reasoning}` : ""),
          );
          // Vista informativa de todos los parámetros que la IA calculó para este track.
          const { platform, reasoning, ...aiParams } = d;
          if (Object.keys(aiParams).length) {
            renderParamsPreview(aiParams, {
              readOnly: true,
              title: "🤖 Parámetros calculados por la IA para este track",
            });
          }

          showStatus(null, `IA calculó los parámetros — procesando…`, "queued");
          startPolling(currentJobId);
        } catch (e) {
          aiHideTyping();
          console.error("Error en auto-master IA:", e);
          aiAppendNote("Error en el auto-mastering: " + e.message);
          showStatus(null, "Error: " + e.message, "error");
        } finally {
          autoBtn.disabled = false;
          masterBtn.disabled = false;
        }
      });

      // ── SUGERIR CON IA (analiza y decide, pero NO masteriza directo) ────────────
      // A diferencia de "Auto-Mastering IA" (que encola el job de una), este botón
      // carga los parámetros calculados por la IA en los controles normales de la
      // cadena — se puede escuchar el preview, tocar cualquier slider a mano, y
      // recién ahí mandar a masterizar con el botón "▶ Masterizar" de siempre.
      document.getElementById("btnAiSuggest").addEventListener("click", async () => {
        if (!selectedFile) {
          showStatus(null, "Selecciona un archivo primero", "error");
          return;
        }
        clearResults();
        showStatus(null, "🤖 La IA está analizando tu track…", "processing");
        const suggestBtn = document.getElementById("btnAiSuggest");
        const autoBtn2 = document.getElementById("btnAutoMaster");
        const masterBtn2 = document.getElementById("btnMaster");
        suggestBtn.disabled = true;
        autoBtn2.disabled = true;
        masterBtn2.disabled = true;

        const panel2 = aiEl("aiPanel");
        if (!panel2.classList.contains("open")) panel2.classList.add("open");
        aiEl("aiSuggestions").innerHTML = "";
        aiShowTyping();

        const fd2 = new FormData();
        if (_previewLibraryId) {
          fd2.append("library_id", _previewLibraryId);
        } else {
          fd2.append("file", selectedFile);
        }
        try {
          const res = await fetch(`${API()}/ai/suggest`, { method: "POST", body: fd2 });
          aiHideTyping();
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          setAiContext(data.analysis);

          const d = data.ai_decision || {};
          const platformLabel = d.platform ? d.platform : "sin target específico";
          aiAppendMessage(
            "assistant",
            `🤖 Analicé el track y armé una propuesta de cadena a medida (no un preset fijo).\nPlataforma: ${platformLabel}\n\nCargué los parámetros en los controles — escuchá el preview, ajustá lo que quieras, y confirmá cuando estés conforme.` +
              (d.reasoning ? `\n\n${d.reasoning}` : ""),
          );

          const { platform, reasoning, ...aiParams } = d;
          if (Object.keys(aiParams).length) {
            // Carga los sliders/checkboxes/selects con los valores sugeridos
            // (misma función que usan los presets) — dispara el preview solo.
            applyPresetToUI(aiParams);
            document.querySelectorAll(".preset-btn.active").forEach((b) => b.classList.remove("active"));
            activePreset = null;
            renderParamsPreview(aiParams, {
              title: "🤖 Parámetros sugeridos por la IA — revisá y confirmá para masterizar",
              confirmLabel: "✅ Confirmar y masterizar",
              onConfirm: submitMasterJob,
            });
          }
          showStatus(null, "Parámetros cargados — revisá y confirmá cuando quieras", "done");
        } catch (e) {
          aiHideTyping();
          console.error("Error en /ai/suggest:", e);
          aiAppendNote("Error al pedir la sugerencia de la IA: " + e.message);
          showStatus(null, "Error: " + e.message, "error");
        } finally {
          suggestBtn.disabled = false;
          autoBtn2.disabled = false;
          masterBtn2.disabled = false;
        }
      });

      // ── ANALYZE (corregido) ──────────────────────────────────────────────────
      async function _handleAnalyzeClick() {
        if (!selectedFile) return;
        clearResults();
        showStatus(null, "Analizando…", "processing");
        const fd = new FormData();
        fd.append("file", selectedFile);
        try {
          const res = await fetch(`${API()}/analyze`, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          showStatus(null, "Análisis completado", "done");
          if (data.lufs != null) showLoudnessMeter(data.lufs);
          renderAnalysisSingle(data);
          if (data.mix_advice) renderAdvicePanel(data.mix_advice, "Evaluación de la mezcla");
          if (data.fft_spectrum) renderFFT([{ label: "Espectro", data: data.fft_spectrum }]);
          setAiContext(data);
        } catch (e) {
          console.error("Error en análisis:", e);
          showStatus(null, "Error: " + e.message, "error");
        }
      }
      ["btnAnalyze", "btnAnalyzeGrid"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("click", _handleAnalyzeClick);
      });

      // ── ADVICE (corregido) ──────────────────────────────────────────────────────
      async function _handleAdviceClick() {
        if (!selectedFile) return;
        clearResults();
        showStatus(null, "Analizando mezcla…", "processing");
        const fd = new FormData();
        fd.append("file", selectedFile);
        try {
          const res = await fetch(`${API()}/mix-advice`, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          showStatus(null, "Evaluación completada", "done");
          if (data.analysis?.lufs != null) showLoudnessMeter(data.analysis.lufs);
          renderAdvicePanel(data, "Evaluación de la mezcla");
          if (data.analysis?.fft_spectrum) renderFFT([{ label: "Espectro", data: data.analysis.fft_spectrum }]);
          if (data.analysis)
            setAiContext({ ...data.analysis, mix_advice: { issues: data.issues, tips: data.tips, score: data.score } });
        } catch (e) {
          console.error("Error en consejos:", e);
          showStatus(null, "Error: " + e.message, "error");
        }
      }
      ["btnAdvice", "btnAdviceGrid"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("click", _handleAdviceClick);
      });

      // ── SPECTRUM (corregido) ──────────────────────────────────────────────────
      document.getElementById("btnSpectrum").addEventListener("click", async () => {
        if (!selectedFile) return;
        clearResults();
        showStatus(null, "Calculando FFT…", "processing");
        const fd = new FormData();
        fd.append("file", selectedFile);
        try {
          const res = await fetch(`${API()}/spectrum?n_fft=4096&n_bins=96`, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          showStatus(null, "Spectrum listo", "done");
          renderFFT([{ label: "Espectro", data }]);
        } catch (e) {
          console.error("Error en spectrum:", e);
          showStatus(null, "Error: " + e.message, "error");
        }
      });

      // ── STEM SEPARATION (#13 — Demucs) ──────────────────────────────────────────
      document.getElementById("btnStems").addEventListener("click", async () => {
        if (!selectedFile) return;
        clearResults();
        showStatus(null, "Separando en stems…", "processing", 0, "En cola…");
        document.getElementById("btnStems").disabled = true;
        const fd = new FormData();
        fd.append("file", selectedFile);
        const stemsMode = document.getElementById("s-stems-mode")?.value || "demucs_4stem";
        fd.append("mode", stemsMode);
        try {
          const res = await fetch(`${API()}/stems/separate`, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          pollStemsJob(data.job_id);
        } catch (e) {
          console.error("Error separando stems:", e);
          showStatus(null, "Error: " + e.message, "error");
          document.getElementById("btnStems").disabled = false;
        }
      });

      function pollStemsJob(jobId) {
        const interval = setInterval(async () => {
          try {
            const res = await fetch(`${API()}/job/${jobId}`);
            const data = await res.json();
            if (data.status === "queued" || data.status === "processing") {
              showStatus(null, "Separando stems…", "processing", data.progress, data.stage);
            } else if (data.status === "done") {
              clearInterval(interval);
              showStatus(null, "Stems listos ✓", "done");
              document.getElementById("btnStems").disabled = false;
              renderStemsPanel(data.stem_analysis, jobId, data.available_stems || []);
            } else if (data.status === "error") {
              clearInterval(interval);
              showStatus(null, "Error: " + data.error, "error");
              document.getElementById("btnStems").disabled = false;
            }
          } catch (e) {
            console.error("Poll stems error:", e);
          }
        }, 1500);
      }

      function renderStemsPanel(stemAnalysis, jobId, availableStems) {
        if (!stemAnalysis) return;
        const wrap = document.createElement("div");
        wrap.className = "stems-wrap";

        const cards = Object.values(stemAnalysis.stems || {})
          .map(
            (s) => `
    <div class="stem-card ${s.is_silent ? "silent" : ""}">
      <div class="stem-title">${s.label || s.name}</div>
      <div class="stem-metric"><span>Peak</span><span>${s.peak_db} dB</span></div>
      <div class="stem-metric"><span>RMS</span><span>${s.rms_db} dB</span></div>
      ${s.lufs != null ? `<div class="stem-metric"><span>LUFS</span><span>${s.lufs}</span></div>` : ""}
      <div class="stem-metric"><span>Banda dominante</span><span>${(s.dominant_band || "—").replace("_", " ")}</span></div>
      ${availableStems.includes(s.name) ? `<a class="stem-dl" href="${API()}/stems/download/${jobId}/${s.name}" target="_blank">⬇ Descargar ${s.name}.wav</a>` : ""}
    </div>
  `,
          )
          .join("");

        const recs = stemAnalysis.recommendations || [];
        const recsHtml = recs.length
          ? recs
              .map(
                (r) => `
        <div class="stem-rec ${r.type === "kick_bass_collision" ? "kick-bass" : ""}">
          ${r.message}
          <div class="rec-score">Score de colisión: ${r.score}${r.band_hz ? ` · Banda: ${r.band_hz[0]}-${r.band_hz[1]} Hz` : ""}</div>
        </div>
      `,
              )
              .join("")
          : `<div style="color:var(--muted);font-size:.78rem">${stemAnalysis.summary || "Sin colisiones detectadas."}</div>`;

        const isRoformer = Object.keys(stemAnalysis.stems || {}).includes("instrumental");
        wrap.innerHTML = `
    <h3>Stems (${isRoformer ? "Roformer — voz/instrumental" : "Demucs — 4 stems"})</h3>
    <div class="stem-cards">${cards}</div>
    <h3 style="margin-top:1.2rem">Recomendaciones</h3>
    ${recsHtml}
  `;
        getContent().prepend(wrap);
      }

      // ── Polling ──────────────────────────────────────────────────────────────────
      function startPolling(jobId) {
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(async () => {
          try {
            const res = await fetch(`${API()}/job/${jobId}`);
            const data = await res.json();
            if (data.status === "queued") {
              showStatus(null, "En cola…", "queued", data.progress, data.stage);
            } else if (data.status === "processing") {
              showStatus(null, "Masterizando…", "processing", data.progress, data.stage);
            } else if (data.status === "done") {
              clearInterval(pollInterval);
              showStatus(null, "Mastering completado ✓", "done");
              document.getElementById("btnMaster").disabled = false;
              downloadUrl = `${API()}/download/${jobId}`;
              const btn = document.getElementById("btnDownload");
              btn.style.display = "block";

              // Activar A/B player — descargar el master en background y decodificar
              const abBtn = document.getElementById("btnAB");
              if (abBtn && typeof setupABPlayer === "function") {
                abBtn.style.display = "block";
                abBtn.disabled = true;
                abBtn.textContent = "⏳ Cargando A/B...";
                fetch(downloadUrl)
                  .then(r => r.blob())
                  .then(masterBlob => setupABPlayer(masterBlob))
                  .then(() => {
                    abBtn.disabled = false;
                    abBtn.textContent = "⚡ A/B";
                  })
                  .catch(() => { abBtn.style.display = "none"; });
              }
              const nameInput = document.getElementById("trackNameInput");
              nameInput.style.display = "block";
              prefillTrackNameFromFile();
              btn.onclick = () => window.open(downloadUrl + currentTrackNameParam(), "_blank");
              const rBtn = document.getElementById("btnReport");
              rBtn.style.display = "block";
              rBtn.onclick = () => downloadReport(jobId);
              if (data.analysis_before?.lufs != null)
                showLoudnessMeter(data.analysis_after?.lufs ?? data.analysis_before.lufs);
              renderAnalysisComparison(data.analysis_before, data.analysis_after);
              if (data.mix_advice_before) renderAdvicePanel(data.mix_advice_before, "Evaluación", "— Antes");
              if (data.mix_advice_after) renderAdvicePanel(data.mix_advice_after, "Evaluación", "— Después");
              // NOTA: ya NO se llama acá a renderChainMeters(data.chain_meters).
              // Ese chain_meters corresponde al render FINAL de la canción
              // entera (job /master), pero las barras de GR (Comp/Multibanda/
              // Glue/De-esser/Dynamic) son el panel de "meters en tiempo
              // real", que debe reflejar SOLO el preview en vivo (WS
              // /ws/master-stream, ya recortado a preview_seconds) — nunca
              // estadísticas de la canción completa, que las pisaban acá.
              // BUGFIX: sin esto, Laia seguía usando el análisis PRE-mastering (o nada)
              // para responder preguntas sobre el resultado ya masterizado, lo que hacía
              // que sus respuestas parecieran genéricas / desactualizadas.
              if (data.analysis_after) setAiContext({ ...data.analysis_after, mix_advice: data.mix_advice_after });
            } else if (data.status === "error") {
              clearInterval(pollInterval);
              showStatus(null, "Error: " + data.error, "error");
              document.getElementById("btnMaster").disabled = false;
            }
          } catch (e) {
            console.error("Poll error:", e);
          }
        }, 1500);
      }
