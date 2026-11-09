"use strict";

// ---- 保存（この端末のブラウザだけに残る） ----
const KEY_PW = "webtest.spi.pw";
const KEY_SETTINGS = "webtest.spi.settings";
const KEY_HISTORY = "webtest.spi.history";

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても続ける */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* noop */ } },
};

// ---- 正誤の判定（build_data.py の norm と同じ規則） ----
function norm(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[（(《][^）)》]*[）)》]/g, "")
    .replace(/[\s　・、。,.]/g, "");
}

function isCorrect(q, answer) {
  if (!q.scored) return null;
  if (q.mode === "text") return q.accepted.includes(norm(answer));
  if (q.mode === "order") return q.accepted.includes(answer);
  const mine = [...answer].sort().join(",");
  return q.accepted.some((a) => [...a].sort().join(",") === mine);
}

function answerLabel(q, answer) {
  if (q.mode === "text") return answer ? answer : "（無回答）";
  if (q.mode === "order") return answer ? answer.split("").join(" → ") : "（無回答）";
  if (!answer || answer.length === 0) return q.optionKind === "kana" ? "該当なし" : "（無回答）";
  if (q.optionKind === "kana") return [...answer].sort().join("と");
  return [...answer].sort().map((k) => {
    const o = q.options.find((x) => x.key === k);
    return o ? `${k} ${o.text}` : k;
  }).join(" / ");
}

function correctLabel(q) {
  if (!q.scored) return "（正解なし）";
  return q.accepted.map((a) => {
    if (q.mode === "text") return a;
    if (q.mode === "order") return a.split("").join(" → ");
    return answerLabel(q, a);
  }).join("　または　");
}

// ---- 復号（AES-GCM、鍵は PBKDF2-SHA256） ----
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function decrypt(blob, password) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: b64(blob.salt), iterations: blob.iter },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(blob.iv) }, key, b64(blob.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---- 画面 ----
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
};

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
  $("loading").hidden = true;
  window.scrollTo(0, 0);
}

let DATA = null;
let blobCache = null;

async function loadBlob() {
  if (!blobCache) {
    const res = await fetch("data.enc.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`data.enc.json を読めません（${res.status}）`);
    blobCache = await res.json();
  }
  return blobCache;
}

async function unlock(password, remember) {
  const blob = await loadBlob();
  DATA = await decrypt(blob, password);
  if (remember) store.set(KEY_PW, password); else store.del(KEY_PW);
  initHome();
  show("home");
}

$("lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter || $("lock-form").querySelector("button");
  btn.disabled = true;
  $("lock-error").textContent = "確かめています…";
  try {
    await unlock($("lock-pw").value, $("lock-remember").checked);
    $("lock-error").textContent = "";
  } catch (err) {
    $("lock-error").textContent = err instanceof DOMException ? "パスワードが違います。" : String(err.message || err);
  } finally {
    btn.disabled = false;
  }
});

$("logout").addEventListener("click", () => {
  store.del(KEY_PW);
  DATA = null;
  $("lock-pw").value = "";
  show("lock");
});

// ---- 設定 ----
function defaultSettings() {
  const seconds = {};
  for (const [k, t] of Object.entries(DATA.types)) seconds[k] = t.seconds;
  return { seconds, types: Object.keys(DATA.types), filter: "all", count: 20, order: "random", mode: "exam", auto: true, sound: true };
}

function loadSettings() {
  const d = defaultSettings();
  const s = store.get(KEY_SETTINGS, {});
  return { ...d, ...s, seconds: { ...d.seconds, ...(s.seconds || {}) } };
}

let settings = null;

function saveSettings() { store.set(KEY_SETTINGS, settings); }

function history() { return store.get(KEY_HISTORY, {}); }

function initHome() {
  settings = loadSettings();
  $("home-title").textContent = DATA.title;
  const hist = history();
  const tbody = $("type-rows");
  tbody.replaceChildren();
  for (const [k, t] of Object.entries(DATA.types)) {
    const qs = DATA.questions.filter((q) => q.type === k && q.scored);
    if (!qs.length) continue;
    const tried = qs.filter((q) => hist[q.id]);
    const n = tried.reduce((a, q) => a + hist[q.id].n, 0);
    const ok = tried.reduce((a, q) => a + hist[q.id].ok, 0);
    const rate = n ? `${Math.round((ok / n) * 100)}%（${tried.length}問・${n}回）` : "—";
    const cb = el("input", { type: "checkbox", "data-type": k });
    cb.checked = settings.types.includes(k);
    cb.addEventListener("change", () => {
      settings.types = [...document.querySelectorAll("#type-rows input[type=checkbox]")].filter((c) => c.checked).map((c) => c.dataset.type);
      saveSettings(); updateStartInfo();
    });
    const sec = el("input", { type: "number", min: "3", max: "600", step: "1", "data-type": k });
    sec.value = settings.seconds[k];
    sec.addEventListener("change", () => {
      const v = Math.max(3, Math.min(600, Math.round(Number(sec.value) || t.seconds)));
      sec.value = v; settings.seconds[k] = v; saveSettings();
    });
    tbody.append(el("tr", {},
      el("td", {}, cb),
      el("td", { text: t.label }),
      el("td", { class: "num", text: `${qs.length}` }),
      el("td", {}, sec, " 秒"),
      el("td", { class: "num", text: rate })));
  }
  $("opt-filter").value = settings.filter;
  $("opt-count").value = String(settings.count);
  $("opt-order").value = settings.order;
  $("opt-mode").value = settings.mode;
  $("opt-auto").checked = settings.auto;
  $("opt-sound").checked = settings.sound;
  updateStartInfo();
}

const bindSetting = (id, key, parse = (v) => v) => {
  $(id).addEventListener("change", (e) => {
    settings[key] = e.target.type === "checkbox" ? e.target.checked : parse(e.target.value);
    saveSettings(); updateStartInfo();
  });
};
bindSetting("opt-filter", "filter");
bindSetting("opt-count", "count", Number);
bindSetting("opt-order", "order");
bindSetting("opt-mode", "mode");
bindSetting("opt-auto", "auto");
bindSetting("opt-sound", "sound");

$("types-all").addEventListener("click", () => { settings.types = Object.keys(DATA.types); saveSettings(); initHome(); });
$("types-none").addEventListener("click", () => { settings.types = []; saveSettings(); initHome(); });
$("times-reset").addEventListener("click", () => { settings.seconds = defaultSettings().seconds; saveSettings(); initHome(); });

function pool() {
  const hist = history();
  return DATA.questions.filter((q) => {
    if (!settings.types.includes(q.type) || !q.scored) return false;
    if (settings.filter === "wrong") return hist[q.id] && (hist[q.id].last !== true || hist[q.id].lastTimedOut);
    if (settings.filter === "new") return !hist[q.id];
    return true;
  });
}

function updateStartInfo() {
  const n = pool().length;
  $("start-info").textContent = `対象 ${n} 問`;
  $("start").disabled = n === 0;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 長文の3問組は、ばらさずに続けて出す。
function buildSet(qs) {
  const units = [];
  const byGroup = new Map();
  for (const q of qs) {
    if (q.group) {
      if (!byGroup.has(q.group)) { byGroup.set(q.group, []); units.push(byGroup.get(q.group)); }
      byGroup.get(q.group).push(q);
    } else units.push([q]);
  }
  if (settings.order === "random") shuffle(units);
  const out = [];
  const limit = settings.count || Infinity;
  for (const u of units) { if (out.length >= limit) break; out.push(...u); }
  return out;
}

$("start").addEventListener("click", () => startQuiz(buildSet(pool())));

// ---- 出題 ----
let session = null;

function startQuiz(questions) {
  if (!questions.length) return;
  session = { questions, index: 0, results: [], startedAt: Date.now() };
  show("quiz");
  renderQuestion();
}

let timer = null;

function renderQuestion() {
  const q = session.questions[session.index];
  const limitMs = (settings.seconds[q.type] || DATA.types[q.type].seconds) * 1000;
  session.current = { q, answer: q.mode === "multi" ? [] : q.mode === "order" ? "" : q.mode === "text" ? "" : [], done: false };

  $("q-progress").textContent = `${session.index + 1} / ${session.questions.length}`;
  $("q-type").textContent = DATA.types[q.type].label;

  const passage = $("q-passage");
  passage.textContent = q.passage;
  passage.className = "passage " + (q.passage.length >= 60 ? "long" : "short");
  passage.scrollTop = 0;
  $("q-prompt").textContent = q.prompt || defaultPrompt(q);

  const body = $("q-body");
  body.replaceChildren();
  if (q.mode === "single" || q.mode === "multi") body.append(renderChoices(q));
  else if (q.mode === "order") body.append(renderOrder(q));
  else body.append(renderText(q));

  $("q-feedback").hidden = true;
  $("q-submit").textContent = "回答して次へ";
  $("q-submit").disabled = false;
  if (settings.mode === "practice") $("q-submit").textContent = "回答する";

  startTimer(limitMs);
}

function defaultPrompt(q) {
  switch (q.type) {
    case "meaning": return "最も適切なものを1つ選びなさい。";
    case "usage": return "下線部（カタカナの部分）と最も近い意味・用法のものを1つ選びなさい。";
    case "pair": return "最初に示された二語と同じ関係になるように、（　）に入る語を選びなさい。";
    case "pair_combo": return "最初に示された二語と同じ関係のものを、ア・イ・ウからすべて選びなさい（ないときは選ばずに回答）。";
    default: return q.mode === "multi" ? "あてはまるものをすべて選びなさい。" : "最も適切なものを1つ選びなさい。";
  }
}

function renderChoices(q) {
  const wrap = el("div", { class: "options" });
  const multi = q.mode === "multi";
  q.options.forEach((o) => {
    const btn = el("button", { class: "opt", type: "button", "data-key": o.key },
      el("span", { class: "key", text: o.key }), el("span", { text: o.text }));
    btn.addEventListener("click", () => choose(o.key));
    wrap.append(btn);
  });
  const hint = multi ? "あてはまるものをすべて選ぶ（もう一度押すと外れます）。キーボードの A〜H・1〜8 でも選べます。" : "キーボードの A〜H・1〜8 でも選べます。Enter で回答。";
  return el("div", {}, wrap, el("div", { class: "hint", text: hint }));
}

function choose(key) {
  const cur = session.current;
  if (cur.done) return;
  if (cur.q.mode === "multi") {
    cur.answer = cur.answer.includes(key) ? cur.answer.filter((k) => k !== key) : [...cur.answer, key];
  } else {
    cur.answer = [key];
  }
  for (const b of document.querySelectorAll("#q-body .opt")) b.classList.toggle("selected", cur.answer.includes(b.dataset.key));
}

function renderOrder(q) {
  const slots = el("div", { class: "order-slots" });
  const frags = el("div", { class: "options" });
  const n = q.options.length;
  const redraw = () => {
    const a = session.current.answer;
    slots.replaceChildren(...Array.from({ length: n }, (_, i) =>
      el("div", { class: "slot" + (a[i] ? " filled" : ""), text: a[i] || "" })));
    for (const b of frags.children) b.classList.toggle("selected", a.includes(b.dataset.key));
  };
  for (const o of q.options) {
    const btn = el("button", { class: "opt", type: "button", "data-key": o.key },
      el("span", { class: "key", text: o.key }), el("span", { text: o.text }));
    btn.addEventListener("click", () => pushOrder(o.key, redraw));
    frags.append(btn);
  }
  const reset = el("button", { type: "button", class: "small", text: "やり直す", onclick: () => { if (!session.current.done) { session.current.answer = ""; redraw(); } } });
  const back = el("button", { type: "button", class: "small", text: "1つ戻す", onclick: () => { if (!session.current.done) { session.current.answer = session.current.answer.slice(0, -1); redraw(); } } });
  session.current.redraw = redraw;
  const wrap = el("div", {}, el("div", { class: "hint", text: "断片を、文の頭から順に押してください（数字キーでも入力できます）。" }), slots,
    el("div", { class: "row-buttons" }, back, reset), frags);
  setTimeout(redraw);
  return wrap;
}

function pushOrder(key, redraw) {
  const cur = session.current;
  if (cur.done || cur.answer.includes(key) || cur.answer.length >= cur.q.options.length) return;
  cur.answer += key;
  (redraw || cur.redraw)();
}

function renderText(q) {
  const input = el("input", { class: "text-answer", type: "text", autocomplete: "off", "aria-label": "答え" });
  input.addEventListener("input", () => { session.current.answer = input.value; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && !e.repeat) { e.preventDefault(); submit(); } });
  setTimeout(() => input.focus());
  return el("div", {}, input, el("div", { class: "hint", text: "文中のことばをそのまま入力してください。" }));
}

// ---- 時限爆弾のタイマー ----
let audio = null;
function beep(freq, ms) {
  if (!settings.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(); const g = audio.createGain();
    o.type = "square"; o.frequency.value = freq; g.gain.value = 0.05;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch { /* 音が出せない環境では鳴らさない */ }
}

function fmt(ms) { return (Math.max(0, ms) / 1000).toFixed(1).padStart(4, "0"); }

function startTimer(limitMs) {
  stopTimer();
  const bomb = $("bomb");
  bomb.className = "bomb";
  $("bomb-limit").textContent = `制限 ${limitMs / 1000} 秒`;
  $("bomb-digits").textContent = fmt(limitMs);
  $("bomb-elapsed").textContent = "0.0";
  const t0 = performance.now();
  let lastSecond = null;
  timer = { t0, limitMs, raf: 0, stoppedAt: null };
  const frame = () => {
    const elapsed = performance.now() - t0;
    const remain = limitMs - elapsed;
    $("bomb-elapsed").textContent = (elapsed / 1000).toFixed(1);
    const fill = $("bomb-fill");
    const ratio = Math.max(0, remain / limitMs);
    fill.style.width = `${ratio * 100}%`;
    fill.style.backgroundColor = ratio > 0.5 ? "#2ecc71" : ratio > 0.25 ? "#f1c40f" : ratio > 0.1 ? "#e67e22" : "#e74c3c";
    if (remain > 0) {
      $("bomb-digits").textContent = fmt(remain);
      bomb.classList.toggle("tick", Math.floor(elapsed / 500) % 2 === 0);
      bomb.classList.toggle("danger", remain <= 3000);
      const sec = Math.ceil(remain / 1000);
      if (sec <= 5 && sec !== lastSecond) { beep(sec <= 2 ? 1320 : 880, 70); }
      lastSecond = sec;
    } else {
      if (!bomb.classList.contains("over")) {
        bomb.classList.add("over"); bomb.classList.remove("danger"); beep(220, 450);
        if (settings.auto) { submit(true); return; }
      }
      $("bomb-digits").textContent = "+" + fmt(-remain).replace(/^0(?=\d\.)/, "");
    }
    timer.raf = requestAnimationFrame(frame);
  };
  timer.raf = requestAnimationFrame(frame);
}

function stopTimer() {
  if (!timer) return 0;
  cancelAnimationFrame(timer.raf);
  const elapsed = performance.now() - timer.t0;
  $("bomb-elapsed").textContent = (elapsed / 1000).toFixed(1);
  $("bomb").classList.add("stopped");
  $("bomb").classList.remove("danger", "tick");
  timer = null;
  return elapsed;
}

// ---- 回答 ----
function submit(timedOut = false) {
  const cur = session.current;
  if (!cur || cur.done) { if (cur && cur.done) next(); return; }
  const limitMs = timer ? timer.limitMs : 0;
  const elapsed = stopTimer();
  cur.done = true;
  const q = cur.q;
  const over = timedOut || elapsed > limitMs;
  // 何も選ばずに時間切れになったときは、該当なしが正解の問題でも不正解にする。
  const untouched = q.mode === "multi" ? cur.answer.length === 0 : false;
  const ok = timedOut && untouched && q.scored ? false : isCorrect(q, cur.answer);
  const result = { q, answer: cur.answer, ok, ms: Math.round(elapsed), timedOut: over };
  session.results.push(result);
  record(result);

  if (settings.mode === "practice") {
    showFeedback(result);
    $("q-submit").textContent = session.index + 1 < session.questions.length ? "次の問題へ" : "結果を見る";
    $("q-submit").focus();
  } else {
    next();
  }
}

function record(r) {
  const hist = history();
  const h = hist[r.q.id] || { n: 0, ok: 0 };
  h.n += 1;
  if (r.ok) h.ok += 1;
  h.last = r.ok === true;
  h.lastTimedOut = r.timedOut;
  h.lastMs = r.ms;
  h.at = Date.now();
  hist[r.q.id] = h;
  store.set(KEY_HISTORY, hist);
}

function showFeedback(r) {
  const q = r.q;
  for (const b of document.querySelectorAll("#q-body .opt")) {
    const k = b.dataset.key;
    if (q.mode === "single" || q.mode === "multi") {
      const inCorrect = q.accepted.some((a) => a.includes(k));
      if (inCorrect) b.classList.add("correct");
      else if (r.answer.includes(k)) b.classList.add("wrong");
    }
  }
  $("q-feedback").replaceChildren(...feedbackNodes(r));
  $("q-feedback").hidden = false;
}

function feedbackNodes(r) {
  const q = r.q;
  const cls = r.ok === null ? "na" : r.ok ? "ok" : "ng";
  const word = r.ok === null ? "採点なし" : r.ok ? "正解" : "不正解";
  const time = `${(r.ms / 1000).toFixed(1)} 秒${r.timedOut ? "（時間切れ）" : ""}`;
  return [
    el("div", { class: `verdict ${cls}`, text: `${word}　${time}` }),
    el("p", {}, el("b", { text: "あなたの答え: " }), answerLabel(q, r.answer)),
    el("p", {}, el("b", { text: "正解: " }), correctLabel(q)),
    ...q.notes.map((n) => el("div", { class: "note", text: n })),
    q.explanation ? el("div", { class: "explain", text: q.explanation }) : null,
  ].filter(Boolean);
}

function next() {
  session.index += 1;
  if (session.index >= session.questions.length) return finish();
  renderQuestion();
}

$("q-submit").addEventListener("click", () => submit());
$("quit").addEventListener("click", () => { stopTimer(); finish(); });

document.addEventListener("keydown", (e) => {
  if ($("quiz").hidden || !session || !session.current) return;
  if (e.target instanceof HTMLInputElement) return;
  const cur = session.current;
  if (e.key === "Enter") { e.preventDefault(); if (!e.repeat) submit(); return; }
  if (cur.done || e.metaKey || e.ctrlKey || e.altKey) return;
  const q = cur.q;
  if (q.mode === "order") {
    if (/^[1-9]$/.test(e.key) && q.options.some((o) => o.key === e.key)) pushOrder(e.key);
    if (e.key === "Backspace") { cur.answer = cur.answer.slice(0, -1); cur.redraw(); }
    return;
  }
  if (q.mode !== "single" && q.mode !== "multi") return;
  let idx = -1;
  const k = e.key.toUpperCase();
  if (/^[A-H]$/.test(k)) idx = k.charCodeAt(0) - 65;
  else if (/^[1-8]$/.test(k)) idx = Number(k) - 1;
  if (idx >= 0 && idx < q.options.length) { e.preventDefault(); choose(q.options[idx].key); }
});

// ---- 結果 ----
function finish() {
  const rs = session.results;
  show("result");
  const scored = rs.filter((r) => r.ok !== null);
  const ok = scored.filter((r) => r.ok).length;
  const total = rs.reduce((s, r) => s + r.ms, 0);
  $("r-score").textContent = scored.length
    ? `${ok} / ${scored.length} 問正解（${Math.round((ok / scored.length) * 100)}%）　合計 ${(total / 1000).toFixed(1)} 秒`
    : "回答した問題はありません";

  const tb = $("r-types");
  tb.replaceChildren();
  for (const [k, t] of Object.entries(DATA.types)) {
    const g = rs.filter((r) => r.q.type === k);
    if (!g.length) continue;
    const gs = g.filter((r) => r.ok !== null);
    const gok = gs.filter((r) => r.ok).length;
    const avg = g.reduce((s, r) => s + r.ms, 0) / g.length / 1000;
    tb.append(el("tr", {},
      el("td", { text: t.label }), el("td", { class: "num", text: g.length }),
      el("td", { class: "num", text: gok }),
      el("td", { class: "num", text: gs.length ? `${Math.round((gok / gs.length) * 100)}%` : "—" }),
      el("td", { class: "num", text: `${avg.toFixed(1)} 秒（制限 ${settings.seconds[k]} 秒）` }),
      el("td", { class: "num", text: g.filter((r) => r.timedOut).length })));
  }
  renderResultList();
  $("r-retry-wrong").disabled = !rs.some((r) => r.ok === false);
}

function renderResultList() {
  const only = $("r-only-wrong").checked;
  const list = $("r-list");
  list.replaceChildren();
  session.results.forEach((r, i) => {
    if (only && r.ok !== false) return;
    const cls = r.ok === null ? "na" : r.ok ? "ok" : "ng";
    const mark = r.ok === null ? "採点なし" : r.ok ? "正解" : "不正解";
    const head = r.q.passage.replace(/\s+/g, " ").slice(0, 34);
    const det = el("details", {},
      el("summary", {},
        el("span", { class: `mark ${cls}`, text: mark }),
        el("span", { text: `${i + 1}. ${DATA.types[r.q.type].label}　${head}${r.q.passage.length > 34 ? "…" : ""}` }),
        el("span", { class: "t", text: `${(r.ms / 1000).toFixed(1)} 秒${r.timedOut ? " 時間切れ" : ""}` })),
      el("div", { class: "detail" },
        el("div", { class: "passage", text: r.q.passage }),
        r.q.prompt ? el("div", { class: "prompt", text: r.q.prompt }) : null,
        (r.q.mode === "single" || r.q.mode === "multi" || r.q.mode === "order")
          ? el("div", { class: "prompt", text: r.q.options.map((o) => `${o.key} ${o.text}`).join("\n") }) : null,
        ...feedbackNodes(r).slice(1)));
    list.append(el("li", {}, det));
  });
}

$("r-only-wrong").addEventListener("change", renderResultList);
$("r-home").addEventListener("click", () => { initHome(); show("home"); });
$("r-retry-wrong").addEventListener("click", () => {
  const wrong = session.results.filter((r) => r.ok === false).map((r) => r.q);
  startQuiz(wrong);
});

// ---- 起動 ----
(async () => {
  const saved = store.get(KEY_PW, null);
  if (saved) {
    try { await unlock(saved, true); return; } catch { store.del(KEY_PW); }
  }
  show("lock");
  $("lock-pw").focus();
})();
