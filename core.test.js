const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./core.js");

/* A real tone with harmonics, optional vibrato and noise, so the detector is
   tested on something closer to a voice than a pure sine. */
function tone(sampleRate, hz, n, harmonics, vibratoCents, noise) {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const f = hz * (1 + ((vibratoCents || 0) / 1200) * Math.sin(2 * Math.PI * 5.5 * t));
    let v = 0;
    for (let h = 1; h <= (harmonics || 1); h += 1) v += (1 / h) * Math.sin(2 * Math.PI * f * h * t);
    v /= Math.log2((harmonics || 1) + 1);
    buf[i] = 0.5 * v + (noise ? (Math.random() * 2 - 1) * noise : 0);
  }
  return buf;
}

test("parses target notes and frequencies", () => {
  assert.ok(Math.abs(S.parseTarget("A3") - 220) < 0.01);
  assert.ok(Math.abs(S.parseTarget("f#2") - 92.4986) < 0.01);
  assert.ok(Math.abs(S.parseTarget("C4") - 261.6256) < 0.01);
  assert.ok(Math.abs(S.parseTarget("440") - 440) < 0.01);
  assert.equal(S.parseTarget("banana"), null);
  assert.equal(S.parseTarget(""), null);
  assert.equal(S.parseTarget("99999"), null);
});

test("names notes the way a musician writes them", () => {
  assert.equal(S.noteName(440), "A4");
  assert.equal(S.noteName(220), "A3");
  assert.equal(S.noteName(261.6256), "C4");
  assert.equal(S.noteName(0), "");
});

test("cents are signed and zero on the target", () => {
  assert.equal(Math.round(S.centsBetween(440, 440)), 0);
  assert.ok(Math.abs(S.centsBetween(880, 440) - 1200) < 0.01);
  assert.equal(Math.round(S.centsBetween(443.2, 440)), 13);
});

test("the detector returns the fundamental, never a subharmonic", () => {
  /* Autocorrelation returns 110 Hz for this 440 Hz sine (four periods score
     as well as one). This is the regression that YIN fixes. */
  const cases = [
    [44100, 440, 4096],
    [48000, 220, 2048],
    [44100, 261.6256, 4096],
    [48000, 110, 2048],
    [44100, 880, 4096],
    [48000, 146.83, 4096]
  ];
  for (const [sr, hz, n] of cases) {
    const out = S.detectPitch(tone(sr, hz, n, 1), sr);
    assert.ok(Math.abs(S.centsBetween(out.hz, hz)) < 5, `${hz} Hz came back as ${out.hz.toFixed(2)}`);
    assert.equal(S.noteName(out.hz), S.noteName(hz));
  }
});

test("the detector keeps the fundamental with eight harmonics", () => {
  const out = S.detectPitch(tone(44100, 146.83, 4096, 8), 44100);
  assert.ok(Math.abs(S.centsBetween(out.hz, 146.83)) < 5, `${out.hz}`);
});

test("the detector finds a low E2 with harmonics and a little noise", () => {
  const out = S.detectPitch(tone(48000, 82.41, 4096, 4, 0, 0.02), 48000);
  assert.ok(Math.abs(S.centsBetween(out.hz, 82.41)) < 10, `${out.hz}`);
});

test("the detector refuses silence and white noise", () => {
  assert.equal(S.detectPitch(new Float32Array(2048), 48000).hz, 0);
  const white = new Float32Array(4096);
  for (let i = 0; i < white.length; i += 1) white[i] = (Math.random() * 2 - 1) * 0.3;
  const out = S.detectPitch(white, 48000);
  assert.equal(out.hz, 0, `noise came back as ${out.hz}`);
});

test("a low-signal buffer is refused on level alone", () => {
  const quiet = tone(48000, 220, 2048, 1);
  for (let i = 0; i < quiet.length; i += 1) quiet[i] *= 0.002;
  const out = S.detectPitch(quiet, 48000);
  assert.equal(out.hz, 0);
  assert.ok(out.rms < S.MIN_RMS);
});

test("a take on pitch scores well and reports no faults", () => {
  const frames = [];
  for (let i = 0; i < 100; i += 1) frames.push({ t: i * 0.03, hz: 220 * Math.pow(2, 0.01 / 12), clarity: 0.9, rms: 0.1 });
  const s = S.summariseTake(frames, 220);
  assert.equal(s.frames, 100);
  assert.ok(s.inTunePercent >= 95, `in tune ${s.inTunePercent}`);
  assert.equal(s.notes.length, 0);
  assert.ok(s.score >= 90, `score ${s.score}`);
  assert.equal(s.targetNote, "A3");
  assert.equal(s.seconds, 3);
});

test("a sharp take is called sharp, a flat take flat", () => {
  const sharp = [], flat = [];
  for (let i = 0; i < 60; i += 1) {
    sharp.push({ t: i * 0.03, hz: 220 * Math.pow(2, 60 / 1200), clarity: 0.9, rms: 0.1 });
    flat.push({ t: i * 0.03, hz: 220 * Math.pow(2, -60 / 1200), clarity: 0.9, rms: 0.1 });
  }
  const a = S.summariseTake(sharp, 220);
  const b = S.summariseTake(flat, 220);
  assert.ok(a.medianCents > 50, `${a.medianCents}`);
  assert.ok(b.medianCents < -50, `${b.medianCents}`);
  assert.ok(a.notes.some((n) => n.includes("sharp")));
  assert.ok(b.notes.some((n) => n.includes("flat")));
  assert.ok(a.score < 60);
});

test("a steady tone one note off is ruled out by the in-tune share", () => {
  const frames = [];
  for (let i = 0; i < 80; i += 1) frames.push({ t: i * 0.03, hz: 220 * Math.pow(2, 200 / 1200), clarity: 0.9, rms: 0.1 });
  const s = S.summariseTake(frames, 220);
  assert.equal(s.inTunePercent, 0);
  assert.ok(s.spread < S.WANDER, "a steady wrong note is not wander");
  assert.ok(s.notes.some((n) => n.includes("landed within")), s.notes.join(" | "));
  assert.ok(s.score < 40);
});

test("wandering pitch is reported as spread and drift", () => {
  const frames = [];
  for (let i = 0; i < 120; i += 1) {
    const cents = -160 + i * 2.7;
    frames.push({ t: i * 0.03, hz: 220 * Math.pow(2, cents / 1200), clarity: 0.9, rms: 0.1 });
  }
  const s = S.summariseTake(frames, 220);
  /* -160 to +161 cents over 3.57 s is 90 cents per second; the fit should say so. */
  assert.ok(Math.abs(s.drift - 90) < 8, `drift ${s.drift}`);
  assert.ok(s.notes.some((n) => n.includes("drifted")));
  assert.ok(s.notes.some((n) => n.includes("wandered")), s.notes.join(" | "));
});

test("an unvoiced take is refused, not scored", () => {
  const frames = [{ t: 0, hz: 0, clarity: 0.1, rms: 0.001 }, { t: 0.03, hz: 0, clarity: 0.1, rms: 0.001 }];
  const s = S.summariseTake(frames, 220);
  assert.equal(s.voiced, 0);
  assert.equal(s.score, 0);
  assert.equal(s.points.length, 0);
  assert.ok(s.notes[0].includes("no pitched sound"));
});

test("mostly silent takes are flagged on the voiced share", () => {
  const frames = [];
  for (let i = 0; i < 40; i += 1) frames.push({ t: i * 0.03, hz: i < 8 ? 220 : 0, clarity: 0.9, rms: 0.1 });
  const s = S.summariseTake(frames, 220);
  assert.equal(s.voiced, 8);
  assert.equal(s.frames, 40);
  assert.ok(s.notes.some((n) => n.includes("percent of frames")));
});

test("the target note is named, not left as a frequency", () => {
  const frames = [{ t: 0, hz: 262, clarity: 0.9, rms: 0.1 }];
  assert.equal(S.summariseTake(frames, S.parseTarget("C4")).targetNote, "C4");
});

test("reading a script finds the missed word and the count", () => {
  const out = S.compareToScript("the quick brown fox jumps over the lazy dog", "the quick brown fox jumps over the dog");
  assert.equal(out.scriptWords, 9);
  assert.equal(out.matched, 8);
  assert.deepEqual(out.missed, ["lazy"]);
  assert.equal(out.coverage, 89);
});

test("the first miss is located in the script, not guessed", () => {
  const out = S.compareToScript("one two three four five", "one two four five");
  assert.deepEqual(out.missed, ["three"]);
  assert.ok(out.notes.some((n) => n.includes('"three" after 2 words')), out.notes.join(" | "));
});

test("an empty reading is refused rather than scored", () => {
  const out = S.compareToScript("call me at four", "");
  assert.equal(out.coverage, 0);
  assert.equal(out.score, 0);
  assert.ok(out.notes.some((n) => n.includes("no words")));
});

test("punctuation and case do not count against the reader", () => {
  const out = S.compareToScript("Hello, world! Good morning.", "hello world good morning");
  assert.equal(out.coverage, 100);
  assert.equal(out.missed.length, 0);
});

test("words added beyond the script are reported", () => {
  const out = S.compareToScript("one two three", "one two three and then some more words here");
  assert.equal(out.coverage, 100);
  assert.ok(out.added.includes("and"));
  assert.ok(out.notes.some((n) => n.includes("not in the script")));
});

test("no script means no false misses", () => {
  const out = S.compareToScript("", "just a few words");
  assert.equal(out.scriptWords, 0);
  assert.equal(out.saidWords, 4);
  assert.equal(out.missed.length, 0);
});

test("a misheard word is a miss and an addition, both reported", () => {
  const out = S.compareToScript("ship the parcel", "ship the partial");
  assert.equal(out.coverage, 67);
  assert.ok(out.missed.includes("parcel"));
  assert.ok(out.added.includes("partial"));
});

test("the pitch hint carries the measured numbers", () => {
  const frames = [];
  for (let i = 0; i < 40; i += 1) frames.push({ t: i * 0.03, hz: 220 * Math.pow(2, 40 / 1200), clarity: 0.9, rms: 0.1 });
  const s = S.summariseTake(frames, 220);
  const e = S.evidence("sing", s);
  assert.equal(e.targetNote, "A3");
  assert.equal(e.medianCentsOffPitch, s.medianCents);
  assert.equal(e.percentWithin35Cents, s.inTunePercent);
  assert.equal(e.driftCentsPerSecond, s.drift);
});

test("the reading hint carries the words, not a verdict on them", () => {
  const r = S.compareToScript("one two three four", "one two three");
  const e = S.evidence("speak", r);
  assert.equal(e.scriptWords, 4);
  assert.deepEqual(e.scriptWordsMissed, ["four"]);
});

test("clip shortens on a boundary and never leaves a half word", () => {
  assert.equal(S.clip("hello world", 50), "hello world");
  const cut = S.clip("hello wonderful world of singing", 20);
  assert.ok(cut.length <= 20, cut);
  assert.ok(cut.endsWith("\u2026"));
  assert.ok(!/worl\u2026$/.test(cut));
});

test("grade bands are ordered", () => {
  assert.equal(S.grade(90).tone, "good");
  assert.equal(S.grade(70).tone, "fair");
  assert.equal(S.grade(50).tone, "weak");
  assert.equal(S.grade(10).tone, "bad");
});

test("the take report carries the numbers and the tip", () => {
  const s = S.summariseTake([{ t: 0, hz: 220, clarity: 0.9, rms: 0.1 }, { t: 0.03, hz: 220, clarity: 0.9, rms: 0.1 }], 220);
  const md = S.toMarkdown("sing", s, "", "Hold the vowel longer.");
  assert.ok(md.includes("**Target:** A3"));
  assert.ok(md.includes("## One thing to change"));
  assert.ok(md.includes("Hold the vowel longer."));
});
