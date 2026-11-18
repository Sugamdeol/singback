/* Singback - the rules for judging one take.
   Pure functions only: no DOM, no network, no globals. The page calls these
   before it draws anything, so a number it shows is one it can defend. */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SINGBACK = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var A4 = 440;
  var NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  var MIN_RMS = 0.008;
  var MIN_CLARITY = 0.6;
  var YIN_THRESHOLD = 0.15;
  var YIN_MAX_CMND = 0.55;
  var IN_TUNE = 35;    /* cents either side of the target that still counts */
  var WANDER = 55;     /* cents of standard deviation treated as wandering */
  var DRIFT = 25;      /* cents per second treated as drifting */
  var LIMITS = { script: 1200, transcript: 4000, tip: 600, subject: 200 };

  function clip(value, max) {
    var s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (s.length <= max) return s;
    return s.slice(0, max - 1).replace(/[\s,;:.]$/, "") + "\u2026";
  }

  /* ------------------------------------------------------------------ notes */

  function hzToMidi(hz) {
    return 69 + 12 * Math.log2(hz / A4);
  }

  function midiToHz(midi) {
    return A4 * Math.pow(2, (midi - 69) / 12);
  }

  function noteName(hz) {
    if (!(hz > 0)) return "";
    var midi = Math.round(hzToMidi(hz));
    var name = NAMES[((midi % 12) + 12) % 12];
    return name + (Math.floor(midi / 12) - 1);
  }

  function centsBetween(hz, targetHz) {
    if (!(hz > 0) || !(targetHz > 0)) return 0;
    return 1200 * Math.log2(hz / targetHz);
  }

  /* Parse "A3", "f#2", "440" into a target in Hz. */
  function parseTarget(text) {
    var s = String(text == null ? "" : text).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      var hz = parseFloat(s);
      return hz > 20 && hz < 5000 ? hz : null;
    }
    var m = s.match(/^([a-gA-G])(#|b)?(-?\d)$/);
    if (!m) return null;
    var index = NAMES.indexOf(m[1].toUpperCase());
    if (index === -1) return null;
    if (m[2] === "#") index += 1;
    if (m[2] === "b") index -= 1;
    var midi = (parseInt(m[3], 10) + 1) * 12 + index;
    return midiToHz(midi);
  }

  /* ------------------------------------------------------------------ pitch */

  /* YIN difference function. Loud but unpitched input (a breath, a hiss)
     comes back with low clarity and is refused by the caller.

     Plain autocorrelation picks a subharmonic on a clean tone: for a 440 Hz
     sine the correlation at four periods is as high as at one, and the larger
     lag wins the search. YIN's cumulative-mean-normalised difference is
     minimum at the true period, which is why it is used here. */
  function detectPitch(buf, sampleRate, opts) {
    opts = opts || {};
    var minHz = opts.minHz || 70;
    var maxHz = opts.maxHz || 1100;
    var n = buf.length;
    if (!n || !(sampleRate > 0)) return { hz: 0, clarity: 0, rms: 0 };

    var mean = 0, i;
    for (i = 0; i < n; i += 1) mean += buf[i];
    mean /= n;

    var x = new Float64Array(n), energy = 0;
    for (i = 0; i < n; i += 1) {
      x[i] = buf[i] - mean;
      energy += x[i] * x[i];
    }
    var rms = Math.sqrt(energy / n);
    if (rms < (opts.minRms || MIN_RMS) || energy <= 0) return { hz: 0, clarity: 0, rms: rms };

    var minLag = Math.max(2, Math.floor(sampleRate / maxHz));
    var maxLag = Math.min(Math.floor(sampleRate / minHz), n - 2);
    if (maxLag <= minLag) return { hz: 0, clarity: 0, rms: rms };

    var cmnd = new Float64Array(maxLag + 1);
    var running = 0;
    cmnd[0] = 1;
    for (var tau = 1; tau <= maxLag; tau += 1) {
      var s = 0;
      for (i = 0; i + tau < n; i += 1) {
        var diff = x[i] - x[i + tau];
        s += diff * diff;
      }
      running += s;
      cmnd[tau] = running > 0 ? (s * tau) / running : 1;
    }

    var threshold = opts.threshold || YIN_THRESHOLD;
    var tau0 = -1;
    for (var t = minLag; t <= maxLag; t += 1) {
      if (cmnd[t] < threshold) {
        while (t + 1 <= maxLag && cmnd[t + 1] < cmnd[t]) t += 1;
        tau0 = t;
        break;
      }
    }
    if (tau0 === -1) {
      var best = -1, bestVal = Infinity;
      for (t = minLag; t <= maxLag; t += 1) {
        if (cmnd[t] < bestVal) { bestVal = cmnd[t]; best = t; }
      }
      if (best > 0 && bestVal < (opts.maxCmnd || YIN_MAX_CMND)) tau0 = best;
    }
    if (tau0 <= 0) return { hz: 0, clarity: 0, rms: rms };

    /* Sub-sample precision from the two neighbours of the minimum. */
    var better = tau0;
    if (tau0 > minLag && tau0 < maxLag) {
      var s0 = cmnd[tau0 - 1], s1 = cmnd[tau0], s2 = cmnd[tau0 + 1];
      var den = 2 * (2 * s1 - s2 - s0);
      if (den !== 0) {
        var shift = (s2 - s0) / den;
        if (shift > -1 && shift < 1) better = tau0 + shift;
      }
    }

    var hz = sampleRate / better;
    var clarity = Math.max(0, Math.min(1, 1 - cmnd[tau0]));
    if (!(hz >= minHz && hz <= maxHz)) return { hz: 0, clarity: clarity, rms: rms };
    if (clarity < (opts.minClarity || MIN_CLARITY)) return { hz: 0, clarity: clarity, rms: rms };
    return { hz: hz, clarity: clarity, rms: rms };
  }

  /* ------------------------------------------------------------------ stats */

  function median(values) {
    if (!values.length) return 0;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function mean(values) {
    if (!values.length) return 0;
    var t = 0;
    for (var i = 0; i < values.length; i += 1) t += values[i];
    return t / values.length;
  }

  function stdev(values) {
    if (values.length < 2) return 0;
    var m = mean(values), t = 0;
    for (var i = 0; i < values.length; i += 1) t += (values[i] - m) * (values[i] - m);
    return Math.sqrt(t / (values.length - 1));
  }

  /* Cents per second across the take, from a least-squares fit. Positive means
     the pitch crept upward as the take went on. */
  function driftPerSecond(points) {
    if (points.length < 3) return 0;
    var n = points.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i += 1) {
      sx += points[i].t; sy += points[i].cents;
      sxx += points[i].t * points[i].t; sxy += points[i].t * points[i].cents;
    }
    var den = n * sxx - sx * sx;
    if (den === 0) return 0;
    return (n * sxy - sx * sy) / den;
  }

  /* frames: [{ t, hz, clarity, rms }] from the live analyser.
     targetHz: what the take was aiming at. */
  function summariseTake(frames, targetHz) {
    var points = [];
    (frames || []).forEach(function (f) {
      if (!(f && f.hz > 0)) return;
      points.push({ t: f.t, cents: centsBetween(f.hz, targetHz), hz: f.hz });
    });
    var total = (frames || []).length;
    var targetNote = noteName(targetHz);
    if (!points.length) {
      return {
        voiced: 0, frames: total, seconds: 0, targetHz: targetHz, targetNote: targetNote,
        medianCents: 0, meanAbsCents: 0, inTunePercent: 0, spread: 0, drift: 0,
        noteCount: 0, points: [], score: 0,
        notes: ["no pitched sound was heard in this take"]
      };
    }

    var cents = points.map(function (p) { return p.cents; });
    var inTune = cents.filter(function (c) { return Math.abs(c) <= IN_TUNE; }).length;
    var seconds = points[points.length - 1].t - points[0].t;
    var notes = [];

    var medianCents = median(cents);
    var meanAbsCents = mean(cents.map(Math.abs));
    var inTunePercent = Math.round((inTune / points.length) * 100);
    var spread = stdev(cents);
    var drift = driftPerSecond(points);

    /* Which written notes actually showed up, longest run first. */
    var runs = [], current = null;
    points.forEach(function (p) {
      var name = noteName(p.hz);
      if (current && current.name === name) current.frames += 1;
      else { current = { name: name, frames: 1 }; runs.push(current); }
    });
    runs.sort(function (a, b) { return b.frames - a.frames; });
    var noteCount = runs.filter(function (r) { return r.frames >= 3; }).length;

    if (inTunePercent < 75) {
      notes.push("only " + inTunePercent + " percent of the take landed within " + IN_TUNE + " cents of " + targetNote);
    }
    if (Math.abs(medianCents) > IN_TUNE) {
      notes.push("the take sat " + Math.abs(Math.round(medianCents)) + " cents " +
        (medianCents > 0 ? "sharp" : "flat") + " of " + targetNote + " on the whole");
    }
    if (spread > WANDER) {
      notes.push("pitch wandered (spread " + Math.round(spread) + " cents), so no note held");
    }
    if (Math.abs(drift) > DRIFT) {
      notes.push("pitch drifted " + Math.round(drift) + " cents per second " +
        (drift > 0 ? "upward" : "downward"));
    }
    if (total && points.length / total < 0.5) {
      notes.push("only " + Math.round((points.length / total) * 100) + " percent of frames carried a clear note");
    }

    var stats = {
      voiced: points.length, frames: total, seconds: Math.round(seconds * 10) / 10,
      targetHz: targetHz, targetNote: targetNote,
      medianCents: Math.round(medianCents), meanAbsCents: Math.round(meanAbsCents),
      inTunePercent: inTunePercent, spread: Math.round(spread),
      drift: Math.round(drift * 10) / 10, noteCount: noteCount,
      points: points, notes: notes, units: "seconds"
    };
    stats.score = scoreTake(stats);
    return stats;
  }

  function scoreTake(s) {
    var score = 100;
    score -= 10 * ((s.notes || []).length);
    score -= Math.round((100 - s.inTunePercent) * 0.5);
    if (s.spread > 50) score -= Math.min(15, Math.round((s.spread - 50) / 5));
    if (Math.abs(s.drift) > 20) score -= Math.min(10, Math.round(Math.abs(s.drift) / 10));
    return Math.max(0, Math.min(100, score));
  }

  /* ----------------------------------------------------------------- speech */

  function words(text) {
    return String(text == null ? "" : text)
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^a-z0-9'\s]/g, " ")
      .split(/\s+/)
      .filter(function (w) { return w.length > 0; });
  }

  /* Longest-common-subsequence alignment of the script against what was
     actually said. Returns each script word with how it landed. */
  function align(script, transcript) {
    var want = words(script), got = words(transcript);
    var n = want.length, m = got.length;
    var table = [];
    for (var i = 0; i <= n; i += 1) table.push(new Array(m + 1).fill(0));
    for (i = 1; i <= n; i += 1) {
      for (var j = 1; j <= m; j += 1) {
        table[i][j] = want[i - 1] === got[j - 1]
          ? table[i - 1][j - 1] + 1
          : Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
    var trace = [];
    i = n; j = m;
    while (i > 0 && j > 0) {
      if (want[i - 1] === got[j - 1]) { trace.push({ word: want[i - 1], said: true }); i -= 1; j -= 1; }
      else if (table[i - 1][j] >= table[i][j - 1]) { trace.push({ word: want[i - 1], said: false }); i -= 1; }
      else { trace.push({ word: got[j - 1], said: false, extra: true }); j -= 1; }
    }
    while (i > 0) { trace.push({ word: want[i - 1], said: false }); i -= 1; }
    while (j > 0) { trace.push({ word: got[j - 1], said: false, extra: true }); j -= 1; }
    return trace.reverse();
  }

  function compareToScript(script, transcript) {
    var want = words(script), got = words(transcript);
    var trace = align(script, transcript);
    var missed = trace.filter(function (t) { return !t.said && !t.extra; });
    var matched = trace.filter(function (t) { return t.said; });
    var added = trace.filter(function (t) { return t.extra; });
    var coverage = want.length ? Math.round((matched.length / want.length) * 100) : 0;
    var notes = [];
    if (!want.length) notes.push("no script was given, so only the words themselves are reported");
    else {
      if (coverage < 80) notes.push("the reading missed " + missed.length + " of the " + want.length + " script words");
      if (missed.length) {
        var firstAt = 0;
        for (var i = 0; i < trace.length; i += 1) { if (trace[i] === missed[0]) break; firstAt += trace[i].said ? 1 : 0; }
        notes.push("the first miss was \"" + missed[0].word + "\" after " + firstAt + " words on target");
      }
      if (added.length > Math.max(2, Math.round(want.length * 0.2))) {
        notes.push(added.length + " words appeared that are not in the script, so the reading wandered");
      }
    }
    if (got.length && !want.length) notes.push(got.length + " words were heard");
    if (!got.length) notes.push("no words came back from the transcription");
    return {
      scriptWords: want.length, saidWords: got.length,
      matched: matched.length, missed: missed.map(function (t) { return t.word; }),
      added: added.map(function (t) { return t.word; }),
      coverage: coverage, trace: trace, notes: notes,
      score: scoreReading(coverage, notes), units: "words"
    };
  }

  function scoreReading(coverage, notes) {
    if (!coverage) return 0;
    var score = Math.round(coverage * 0.85);
    score -= 8 * Math.max(0, (notes || []).length - 1);
    return Math.max(0, Math.min(100, score));
  }

  function grade(n) {
    if (n >= 85) return { label: "solid", tone: "good" };
    if (n >= 65) return { label: "readable, with gaps", tone: "fair" };
    if (n >= 40) return { label: "unsteady", tone: "weak" };
    return { label: "do not trust this take", tone: "bad" };
  }

  /* The evidence block handed to the model. Numbers only, so the tip it writes
     is tied to what was actually measured. */
  function evidence(mode, stats) {
    if (mode === "sing") {
      return {
        mode: "singing against a target note",
        targetNote: stats.targetNote,
        secondsOfPitchedSound: stats.seconds,
        percentWithin35Cents: stats.inTunePercent,
        medianCentsOffPitch: stats.medianCents,
        pitchSpreadCents: stats.spread,
        driftCentsPerSecond: stats.drift,
        distinctNotesHeld: stats.noteCount,
        measuredNotes: stats.notes
      };
    }
    return {
      mode: "reading aloud against a script",
      scriptWords: stats.scriptWords,
      wordsHeard: stats.saidWords,
      wordsOnTarget: stats.matched,
      scriptWordsMissed: stats.missed.slice(0, 20),
      wordsNotInScript: stats.added.slice(0, 20),
      coveragePercent: stats.coverage,
      measuredNotes: stats.notes
    };
  }

  function toMarkdown(mode, stats, raw, tip) {
    var lines = ["# Singback take", "", "**Mode:** " + mode, ""];
    if (mode === "sing") {
      lines.push("**Target:** " + stats.targetNote + " (" + Math.round(stats.targetHz) + " Hz)",
        "**Pitched sound:** " + stats.seconds + " s",
        "**Within " + IN_TUNE + " cents:** " + stats.inTunePercent + "%",
        "**Median offset:** " + stats.medianCents + " cents",
        "**Spread:** " + stats.spread + " cents",
        "**Drift:** " + stats.drift + " cents per second", "");
    } else {
      lines.push("**Script words:** " + stats.scriptWords,
        "**Words heard:** " + stats.saidWords,
        "**On target:** " + stats.matched + " (" + stats.coverage + "%)", "");
      if (stats.missed.length) lines.push("**Missed:** " + stats.missed.join(", "), "");
    }
    if (stats.notes.length) {
      lines.push("## Measured", "");
      stats.notes.forEach(function (n) { lines.push("- " + n); });
      lines.push("");
    }
    if (raw) lines.push("## What was heard", "", clip(raw, LIMITS.transcript), "");
    if (tip) lines.push("## One thing to change", "", clip(tip, LIMITS.tip), "");
    return lines.join("\n");
  }

  return {
    LIMITS: LIMITS, IN_TUNE: IN_TUNE, WANDER: WANDER, DRIFT: DRIFT,
    MIN_CLARITY: MIN_CLARITY, MIN_RMS: MIN_RMS,
    clip: clip, noteName: noteName, hzToMidi: hzToMidi, midiToHz: midiToHz,
    centsBetween: centsBetween, parseTarget: parseTarget, detectPitch: detectPitch,
    median: median, mean: mean, stdev: stdev, driftPerSecond: driftPerSecond,
    summariseTake: summariseTake, scoreTake: scoreTake,
    words: words, align: align, compareToScript: compareToScript,
    scoreReading: scoreReading, grade: grade, evidence: evidence, toMarkdown: toMarkdown
  };
});
