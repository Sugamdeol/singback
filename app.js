/* Singback - take one audio clip, measure it locally, ask a model for one tip.
   No build step, no dependencies, no server. Visitors pay with their own Pollen. */

(function () {
  "use strict";

  var S = window.SINGBACK;

  var CFG = {
    clientId: "pk_3jCFZ0ojc5QIeYps",
    authEndpoint: "https://enter.pollinations.ai/authorize",
    tokenEndpoint: "https://enter.pollinations.ai/api/oauth/token",
    userinfoEndpoint: "https://enter.pollinations.ai/api/oauth/userinfo",
    chatEndpoint: "https://gen.pollinations.ai/v1/chat/completions",
    transcribeEndpoint: "https://gen.pollinations.ai/v1/audio/transcriptions",
    scope: "profile usage",
    models: "audio,text",
    budget: 3,
    expiryDays: 7
  };

  var TEXT_MODEL = "openai/gpt-5.4-nano";
  var TRANSCRIBE_MODEL = "openai/whisper-large-v3";
  var MAX_TAKE_MS = 20000;

  var COACH = [
    "You coach one singing or speaking take. You get the measured numbers, and the transcript when there is one.",
    "",
    "Write ONE tip: at most two sentences, plain prose, no lists, no headings, no praise padding.",
    "Name the single biggest fault the numbers show and give one concrete thing to do differently next take.",
    "Use only what the numbers say. If the numbers show nothing wrong, say what was solid and give one thing to raise.",
    "Never invent a measurement, a note name, a word, or a cause the numbers do not support.",
    "Do not mention that you were given numbers or a transcript. Talk about the take."
  ].join("\n");

  var $ = function (sel) { return document.querySelector(sel); };

  var state = {
    mode: "sing",
    token: sessionStorage.getItem("singback.token") || null,
    frames: [],
    points: [],
    recordChunks: [],
    recorder: null,
    stream: null,
    audioCtx: null,
    analyser: null,
    source: null,
    buffer: null,
    listening: false,
    startedAt: 0,
    takeMs: 0,
    mimeType: "",
    stats: null,
    transcript: "",
    tip: "",
    busy: false
  };

  /* ------------------------------------------------------------------ auth */

  function pageUrl() {
    return window.location.origin + window.location.pathname.replace(/index\.html$/, "");
  }

  function b64url(buf) {
    var bytes = new Uint8Array(buf), s = "";
    for (var i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function rnd(n) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    var b = new Uint8Array(n), out = "";
    crypto.getRandomValues(b);
    for (var i = 0; i < n; i += 1) out += alphabet[b[i] % alphabet.length];
    return out;
  }

  function signIn() {
    var verifier = rnd(64), nonce = rnd(24);
    sessionStorage.setItem("singback.verifier", verifier);
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(b64url).then(function (challenge) {
      var params = new URLSearchParams({
        response_type: "code",
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        scope: CFG.scope,
        models: CFG.models,
        budget: String(CFG.budget),
        expiry: String(CFG.expiryDays),
        state: nonce,
        code_challenge: challenge,
        code_challenge_method: "S256"
      });
      window.location.assign(CFG.authEndpoint + "?" + params.toString());
    });
  }

  function finishSignIn() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code"), err = params.get("error");
    if (!code && !err) return Promise.resolve(false);
    if (window.history && window.history.replaceState) window.history.replaceState(null, "", pageUrl());
    if (err) {
      say("Sign in failed: " + err + " " + (params.get("error_description") || ""), "err");
      return Promise.resolve(true);
    }
    var verifier = sessionStorage.getItem("singback.verifier");
    if (!verifier) {
      say("Sign in could not finish because this tab lost its verifier. Sign in again.", "err");
      return Promise.resolve(true);
    }
    say("Finishing sign in...", "");
    return fetch(CFG.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        code_verifier: verifier
      })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok || !d.access_token) {
          throw new Error((d && (d.error_description || d.error)) || ("HTTP " + r.status));
        }
        state.token = d.access_token;
        sessionStorage.setItem("singback.token", state.token);
        sessionStorage.removeItem("singback.verifier");
      });
    }).then(function () {
      say("Signed in. Your own Pollen pays for each reading.", "ok");
      return loadUser();
    }).catch(function (e) {
      say("Sign in failed: " + (e && e.message ? e.message : "unknown error"), "err");
    }).then(function () { return true; });
  }

  function loadUser() {
    if (!state.token) {
      $("#who").textContent = "";
      $("#signBtn").textContent = "Sign in with Pollen";
      return Promise.resolve();
    }
    $("#signBtn").textContent = "Sign out";
    $("#who").textContent = "using your Pollen";
    return fetch(CFG.userinfoEndpoint, { headers: { Authorization: "Bearer " + state.token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (u) {
        if (u && (u.name || u.username)) $("#who").textContent = "your Pollen: " + (u.name || u.username);
      })
      .catch(function () {});
  }

  /* -------------------------------------------------------------- listening */

  /* The canvas backing store must match its CSS box, or the browser stretches
     the drawing and the axis labels come out horizontally squashed. */
  function sizeCanvas() {
    var cv = $("#trace");
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(320, Math.round((cv.clientWidth || 1120) * dpr));
    var h = Math.max(120, Math.round((cv.clientHeight || 172) * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    return cv;
  }

  function drawIdle() {
    var cv = sizeCanvas(), ctx = cv.getContext("2d");
    var w = cv.width, h = cv.height, mid = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "#2c2b38";
    ctx.lineWidth = 1;
    for (var i = 1; i < 4; i += 1) {
      ctx.beginPath();
      ctx.moveTo(0, (h / 4) * i);
      ctx.lineTo(w, (h / 4) * i);
      ctx.stroke();
    }
    ctx.fillStyle = "#4a4859";
    ctx.font = Math.round(12 * (window.devicePixelRatio || 1)) + "px ui-monospace, monospace";
    ctx.fillText("waiting for a take", 14, mid + 4);
  }

  function drawTrace() {
    var cv = sizeCanvas(), ctx = cv.getContext("2d");
    var w = cv.width, h = cv.height, mid = h / 2;
    var dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = "#2c2b38";
    ctx.lineWidth = 1;
    for (var i = 1; i < 4; i += 1) {
      ctx.beginPath();
      ctx.moveTo(0, (h / 4) * i);
      ctx.lineTo(w, (h / 4) * i);
      ctx.stroke();
    }
    ctx.strokeStyle = "#413c2a";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    var pad = 40 * dpr;
    ctx.fillStyle = "#6a6779";
    ctx.font = Math.round(11 * dpr) + "px ui-monospace, monospace";
    ctx.fillText("+50", 6, mid - (mid - 14 * dpr) + 12 * dpr);
    ctx.fillText("0", 6, mid + 4 * dpr);
    ctx.fillText("-50", 6, mid + (mid - 14 * dpr));

    var pts = state.points;
    if (pts.length < 2) return;

    var span = 6;
    var t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
    if (t1 - t0 > span) t0 = t1 - span;

    ctx.strokeStyle = "#f0c05a";
    ctx.lineWidth = 2.2 * dpr;
    ctx.beginPath();
    var started = false;
    pts.forEach(function (p) {
      if (p.t < t0) return;
      var x = pad + ((p.t - t0) / (t1 - t0)) * (w - pad - 8 * dpr);
      var cents = Math.max(-50, Math.min(50, p.cents));
      var y = mid - (cents / 50) * (mid - 14 * dpr);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    var last = pts[pts.length - 1];
    var lx = pad + ((last.t - t0) / (t1 - t0)) * (w - pad - 8 * dpr);
    var ly = mid - (Math.max(-50, Math.min(50, last.cents)) / 50) * (mid - 14 * dpr);
    ctx.fillStyle = Math.abs(last.cents) <= S.IN_TUNE ? "#7fd6b0" : "#e58a7d";
    ctx.beginPath();
    ctx.arc(lx, ly, 5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  /* One analysis window, one frame. Frames carry the time from the take start,
     so the trace and the statistics are in the same clock. */
  function sampleFrame() {
    if (!state.listening || !state.analyser) return;
    var buf = state.buffer, analyser = state.analyser;
    analyser.getFloatTimeDomainData(buf);
    var out = S.detectPitch(buf, state.audioCtx.sampleRate);
    var t = (performance.now() - state.startedAt) / 1000;
    state.frames.push({ t: t, hz: out.hz, clarity: out.clarity, rms: out.rms });
    if (out.hz > 0) {
      var target = S.parseTarget($("#target").value) || 220;
      state.points.push({ t: t, hz: out.hz, cents: S.centsBetween(out.hz, target) });
    }
    liveReadout(out, t);
    drawTrace();
  }

  function liveReadout(out, t) {
    if (state.mode !== "sing") {
      $("#pillNote").innerHTML = "mode <b>reading</b>";
      $("#pillCents").innerHTML = "clarity <b>" + (out.clarity ? out.clarity.toFixed(2) : "0.00") + "</b>";
      $("#pillLevel").innerHTML = "level <b>" + (out.rms ? (20 * Math.log10(out.rms)).toFixed(0) + " dB" : "silent") + "</b>";
      $("#pillTime").innerHTML = "time <b>" + t.toFixed(1) + " s</b>";
      return;
    }
    var target = S.parseTarget($("#target").value) || 220;
    var noteEl = $("#pillNote"), centsEl = $("#pillCents");
    if (out.hz > 0) {
      var cents = S.centsBetween(out.hz, target);
      noteEl.innerHTML = "note <b>" + S.noteName(out.hz) + "</b>";
      noteEl.className = "pill" + (Math.abs(cents) <= S.IN_TUNE ? " good" : "");
      centsEl.innerHTML = "offset <b>" + (cents > 0 ? "+" : "") + cents.toFixed(0) + " cents</b>";
      centsEl.className = "pill" + (Math.abs(cents) <= S.IN_TUNE ? " good" : " bad");
    } else {
      noteEl.innerHTML = "note <b>-</b>";
      noteEl.className = "pill";
      centsEl.innerHTML = "offset <b>-</b>";
      centsEl.className = "pill";
    }
    $("#pillLevel").innerHTML = "level <b>" + (out.rms ? (20 * Math.log10(out.rms)).toFixed(0) + " dB" : "silent") + "</b>";
    $("#pillTime").innerHTML = "time <b>" + t.toFixed(1) + " s</b>";
  }

  function pickMime() {
    var options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (var i = 0; i < options.length; i += 1) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(options[i])) return options[i];
    }
    return "";
  }

  function start() {
    if (state.listening) return stop();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say("This browser does not expose a microphone. Try a current desktop browser.", "err");
      return;
    }
    state.frames = [];
    state.points = [];
    state.recordChunks = [];
    state.stats = null;
    state.transcript = "";
    state.tip = "";
    hideResult();
    say("Starting the microphone...", "");

    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }).then(function (stream) {
      state.stream = stream;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new Ctx();
      state.source = state.audioCtx.createMediaStreamSource(stream);
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = 2048;
      state.buffer = new Float32Array(state.analyser.fftSize);
      state.source.connect(state.analyser);

      var mime = pickMime();
      state.mimeType = mime;
      try {
        state.recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        state.recorder.ondataavailable = function (e) { if (e.data && e.data.size) state.recordChunks.push(e.data); };
        state.recorder.start(250);
      } catch (e) {
        /* Pitch still works without a recorder; only the transcript is lost. */
        state.recorder = null;
        state.recordError = e && e.message ? e.message : "the recorder did not start";
      }

      state.listening = true;
      state.startedAt = performance.now();
      $("#recBtn").textContent = "Stop";
      $("#recBtn").classList.add("on");
      $("#readBtn").disabled = true;
      $("#canvasNote").textContent = state.mode === "sing"
        ? "pitch trace, darkness to now, +/-50 cents"
        : "listening for the reading";
      say("Listening. " + (state.mode === "sing"
        ? "Hold the note steady, then stop."
        : "Read your script at a normal pace, then stop."), "ok");

      state.timer = window.setInterval(function () {
        sampleFrame();
        if (performance.now() - state.startedAt > MAX_TAKE_MS) stop();
      }, 60);
    }).catch(function (e) {
      say("The microphone did not start: " + (e && e.message ? e.message : "permission refused") +
        ". Allow microphone access for this page and try again.", "err");
    });
  }

  function stop() {
    if (!state.listening) return;
    state.listening = false;
    window.clearInterval(state.timer);
    state.takeMs = performance.now() - state.startedAt;
    $("#recBtn").textContent = "Start listening";
    $("#recBtn").classList.remove("on");
    drawTrace();

    var finished = Promise.resolve();
    if (state.recorder && state.recorder.state !== "inactive") {
      finished = new Promise(function (resolve) {
        state.recorder.onstop = function () { resolve(); };
        try { state.recorder.stop(); } catch (e) { resolve(); }
      });
    }
    finished.then(function () {
      if (state.stream) state.stream.getTracks().forEach(function (t) { t.stop(); });
      if (state.audioCtx && state.audioCtx.close) state.audioCtx.close();
      state.recorder = null;
      state.stream = null;
      state.audioCtx = null;
      state.analyser = null;

      var voiced = state.points.length;
      if (!voiced) {
        say("Nothing pitched was picked up. Check the input device and sing or speak closer to the microphone.", "err");
        $("#readBtn").disabled = true;
        return;
      }
      if (state.mode === "sing") {
        var target = S.parseTarget($("#target").value) || 220;
        state.stats = S.summariseTake(state.frames, target);
        showPitchResult(state.stats);
      } else {
        state.stats = null;
      }
      if (!state.recordChunks.length) {
        say("The clip itself did not record" + (state.recordError ? " (" + state.recordError + ")" : "") +
          ", so no transcript is possible. The measurements above still stand.", "err");
        $("#readBtn").disabled = true;
        return;
      }
      var blob = new Blob(state.recordChunks, { type: state.mimeType || "audio/webm" });
      state.blob = blob;
      $("#readBtn").disabled = false;
      say("Take captured: " + (state.takeMs / 1000).toFixed(1) + " s of audio. Ask for the feedback when ready.", "ok");
    });
  }

  /* ----------------------------------------------------------------- result */

  function hideResult() {
    $("#result").hidden = true;
    $("#statGrid").innerHTML = "";
    $("#notes").innerHTML = "";
    $("#tipBox").hidden = true;
    $("#readbackBox").hidden = true;
    $("#wordsBox").hidden = true;
    $("#copyBtn").hidden = true;
  }

  function statTile(key, value, unit) {
    var div = document.createElement("div");
    div.className = "stat";
    var k = document.createElement("div");
    k.className = "k";
    k.textContent = key;
    var v = document.createElement("div");
    v.className = "v";
    v.textContent = value;
    if (unit) {
      var u = document.createElement("span");
      u.className = "u";
      u.textContent = " " + unit;
      v.appendChild(u);
    }
    div.appendChild(k);
    div.appendChild(v);
    return div;
  }

  function showPitchResult(stats) {
    var grid = $("#statGrid");
    grid.innerHTML = "";
    grid.appendChild(statTile("Target", stats.targetNote, Math.round(stats.targetHz) + " Hz"));
    grid.appendChild(statTile("On pitch", stats.inTunePercent, "% within " + S.IN_TUNE + " cents"));
    grid.appendChild(statTile("Median offset", (stats.medianCents > 0 ? "+" : "") + stats.medianCents, "cents"));
    grid.appendChild(statTile("Spread", stats.spread, "cents"));
    grid.appendChild(statTile("Drift", (stats.drift > 0 ? "+" : "") + stats.drift, "cents per second"));
    grid.appendChild(statTile("Pitched sound", stats.seconds, "seconds"));
    var list = $("#notes");
    list.innerHTML = "";
    stats.notes.forEach(function (n) {
      var li = document.createElement("li");
      li.className = "warn";
      li.textContent = n;
      list.appendChild(li);
    });
    if (!stats.notes.length) {
      var li = document.createElement("li");
      li.textContent = "Nothing stood out: the pitch held near " + stats.targetNote +
        ", the spread stayed under " + S.WANDER + " cents and there was no drift.";
      list.appendChild(li);
    }
    $("#result").hidden = false;
  }

  function showReadingResult(reading, transcript) {
    var grid = $("#statGrid");
    grid.innerHTML = "";
    grid.appendChild(statTile("Script words", reading.scriptWords));
    grid.appendChild(statTile("On target", reading.matched, "of " + reading.scriptWords));
    grid.appendChild(statTile("Coverage", reading.coverage, "%"));
    grid.appendChild(statTile("Words heard", reading.saidWords));
    grid.appendChild(statTile("Missed", reading.missed.length));
    grid.appendChild(statTile("Words not in script", reading.added.length));

    var words = $("#words");
    words.innerHTML = "";
    reading.trace.forEach(function (entry) {
      var span = document.createElement("span");
      span.textContent = entry.word;
      span.className = entry.said ? "hit" : (entry.extra ? "extra" : "miss");
      words.appendChild(span);
    });
    $("#wordsBox").hidden = false;

    var readback = $("#readbackBox");
    readback.innerHTML = "";
    var p = document.createElement("p");
    p.style.color = "var(--muted)";
    p.style.fontSize = "13px";
    p.textContent = "Transcribed by " + TRANSCRIBE_MODEL;
    readback.appendChild(p);
    var body = document.createElement("p");
    body.textContent = transcript || "(nothing came back)";
    readback.appendChild(body);
    readback.hidden = false;

    var list = $("#notes");
    list.innerHTML = "";
    reading.notes.forEach(function (n) {
      var li = document.createElement("li");
      li.className = "warn";
      li.textContent = n;
      list.appendChild(li);
    });
    $("#result").hidden = false;
  }

  function showTip(text) {
    if (!text) return;
    $("#tipText").textContent = text;
    $("#tipBox").hidden = false;
    $("#copyBtn").hidden = false;
  }

  function say(text, tone) {
    var el = $("#status");
    el.textContent = text || "";
    el.className = "status" + (tone ? " " + tone : "");
  }

  /* ------------------------------------------------------------------- call */

  function transcribe(blob) {
    var form = new FormData();
    var name = (blob.type || "").indexOf("mp4") !== -1 ? "take.mp4" : "take.webm";
    form.append("file", blob, name);
    form.append("model", TRANSCRIBE_MODEL);
    form.append("response_format", "json");
    return fetch(CFG.transcribeEndpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + state.token },
      body: form
    }).then(function (r) {
      return r.text().then(function (t) {
        var d;
        try { d = JSON.parse(t); } catch (e) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 180)); }
        if (!r.ok) {
          var msg = d && d.error ? (d.error.message || JSON.stringify(d.error)) : ("HTTP " + r.status);
          throw new Error(msg);
        }
        return (d.text || "").trim();
      });
    });
  }

  function coach(target, transcript) {
    return fetch(CFG.chatEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages: [
          { role: "system", content: COACH },
          { role: "user", content: JSON.stringify(target) + (transcript ? "\n\nTranscript of the take: " + transcript : "\n\nNo transcript for this take.") }
        ],
        max_tokens: 220
      })
    }).then(function (r) {
      return r.text().then(function (t) {
        var d;
        try { d = JSON.parse(t); } catch (e) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 180)); }
        if (!r.ok) throw new Error((d.error && (d.error.message || d.error)) || ("HTTP " + r.status));
        var text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        if (!text) throw new Error("the model returned no content");
        return text.replace(/```/g, "").trim();
      });
    });
  }

  function requestFeedback() {
    if (state.busy) return;
    if (!state.token) { say("Sign in with Pollinations first, so the models are paid from your own balance.", "err"); return; }
    if (!state.blob) { say("Record a take first.", "err"); return; }
    if (state.mode === "speak" && !state.stats && !state.frames.length) { say("Record a take first.", "err"); return; }

    state.busy = true;
    $("#readBtn").disabled = true;
    $("#readBtn").textContent = "Working...";
    say("Sending the clip to " + TRANSCRIBE_MODEL + "...", "");

    transcribe(state.blob).then(function (text) {
      state.transcript = text;
      var evidence;
      if (state.mode === "sing") {
        evidence = S.evidence("sing", state.stats);
        state.stats.transcript = text;
        showPitchResult(state.stats);
        say("Asking " + TEXT_MODEL + " for one thing to change...", "");
      } else {
        var reading = S.compareToScript($("#script").value, text);
        state.stats = reading;
        showReadingResult(reading, text);
        evidence = S.evidence("speak", reading);
        say("Asking " + TEXT_MODEL + " for one thing to change...", "");
      }
      return coach(evidence, text).then(function (tip) {
        state.tip = tip;
        showTip(tip);
        say("Done. One take, one tip, all measured from your own audio.", "ok");
      });
    }).catch(function (e) {
      say("The feedback failed: " + (e && e.message ? e.message : "unknown error"), "err");
    }).then(function () {
      state.busy = false;
      $("#readBtn").disabled = false;
      $("#readBtn").textContent = "Get feedback";
    });
  }

  /* ------------------------------------------------------------------ wiring */

  function setMode(mode) {
    if (state.listening) stop();
    state.mode = mode;
    $("#tabSing").setAttribute("aria-selected", String(mode === "sing"));
    $("#tabSpeak").setAttribute("aria-selected", String(mode === "speak"));
    $("#singFields").hidden = mode !== "sing";
    $("#speakFields").hidden = mode !== "speak";
    $("#setupHint").textContent = mode === "sing"
      ? "Your microphone is used only in this tab. Pitch is measured locally; the clip only leaves the browser when you ask for the transcription."
      : "Your microphone is used only in this tab. The clip is sent to the transcription model when you ask for a reading, then compared with your script locally.";
    $("#canvasNote").textContent = mode === "sing" ? "pitch trace appears here while you sing" : "listening indicator";
    hideResult();
    drawIdle();
  }

  function buildTargets() {
    var box = $("#targetPick");
    box.innerHTML = "";
    ["C3", "D3", "E3", "F3", "G3", "A3", "C4", "D4", "E4", "G4", "A4"].forEach(function (name) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn-ghost";
      b.style.padding = "6px 11px";
      b.style.fontSize = "13px";
      b.textContent = name;
      b.addEventListener("click", function () {
        $("#target").value = name;
        state.frames = [];
        state.points = [];
        drawIdle();
        say("Target set to " + name + ". Press Start listening.", "");
      });
      box.appendChild(b);
    });
  }

  function copyReport() {
    var text = S.toMarkdown(state.mode === "sing" ? "sing" : "speak", state.stats, state.transcript, state.tip);
    var done = function () { say("Report copied to the clipboard.", "ok"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { say(text, ""); });
    } else {
      say("Clipboard is not available in this browser.", "err");
    }
  }

  function init() {
    buildTargets();
    drawIdle();
    $("#tabSing").addEventListener("click", function () { setMode("sing"); });
    $("#tabSpeak").addEventListener("click", function () { setMode("speak"); });
    $("#recBtn").addEventListener("click", start);
    $("#readBtn").addEventListener("click", requestFeedback);
    $("#clearBtn").addEventListener("click", function () {
      state.frames = [];
      state.points = [];
      state.stats = null;
      state.blob = null;
      state.transcript = "";
      state.tip = "";
      state.recordChunks = [];
      hideResult();
      drawIdle();
      say("", "");
    });
    $("#copyBtn").addEventListener("click", copyReport);
    $("#signBtn").addEventListener("click", function () {
      if (state.token) {
        state.token = null;
        sessionStorage.removeItem("singback.token");
        loadUser();
        say("Signed out.", "");
        return;
      }
      signIn();
    });
    $("#target").addEventListener("change", function () {
      state.frames = [];
      state.points = [];
      drawIdle();
    });
    window.addEventListener("resize", function () {
      if (state.points.length) drawTrace(); else drawIdle();
    });
    finishSignIn().then(loadUser);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
