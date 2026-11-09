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
  if (!answer || answer.length === 0) return "（無回答）";
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
  $("app").classList.toggle("wide", id === "quiz");
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

// ---- 出題（テストセンターの画面に寄せる） ----
const INSTR = {
  meaning: "下線部の言葉と意味が最もよく合致するものを1つ選びなさい。",
  usage: "下線部分の語の意味を考え、選択肢の中で下線の語がこれと最も近い意味に使われているものを1つ選びなさい。",
  pair: "はじめに示された二語の関係を考えて、同じ関係になるように（　）にあてはまる語を1つ選びなさい。",
  pair_combo: "はじめに示された二語の関係を考えて、同じ関係を表す対をア・イ・ウの中から選びなさい。",
  blank_short: "つぎの文の意味やことばの使い方から考えて、［　］に入れる語句として最も適切なものを1つ選びなさい。",
  blank_passage: "つぎの文を読んで、文中の空所に入れる語句として最も適切なものを1つ選びなさい。",
  order_slot: "AからEまでのことばを空所［ 1 ］から［ 5 ］に入れて意味の通る文を完成させます。そのとき指定された空所にあてはまるものを1つ選びなさい。",
  order_seq: "1から5までのことばを並べ替えて、意味の通る文を完成させなさい。文の頭にくるものから順に選びます。",
  reading: "つぎの文を読んで、各問いに答えなさい。",
};

// ア・イ・ウの問題は、本番と同じく6つの組み合わせから1つ選ぶ。
const KANA_COMBOS = [
  { key: "A", text: "アだけ", set: ["ア"] }, { key: "B", text: "イだけ", set: ["イ"] }, { key: "C", text: "ウだけ", set: ["ウ"] },
  { key: "D", text: "アとイ", set: ["ア", "イ"] }, { key: "E", text: "アとウ", set: ["ア", "ウ"] }, { key: "F", text: "イとウ", set: ["イ", "ウ"] },
];

const sameSet = (a, b) => [...a].sort().join(",") === [...b].sort().join(",");

function instrFor(q) {
  if (q.type === "order") return INSTR[q.mode === "order" ? "order_seq" : "order_slot"];
  return INSTR[q.type] || "";
}

function choiceList(q) {
  return q.optionKind === "kana" ? KANA_COMBOS : q.options;
}

// 本文の表示用の整形（空所の記号をそろえ、下線を引く）
function passageNodes(q) {
  let text = q.passage
    .replace(/《([ァ-ヶー]+)》/g, "($1)")
    .replace(/[＝ー]{3,}/g, "［　　　］")
    .replace(/＝＝\s*([^＝\s]{1,2})\s*＝＝/g, "［ $1 ］");
  if (q.type === "order" && q.mode === "order") text = text.replace(/\s*12345\s*/, "［1］［2］［3］［4］［5］");
  if (q.type !== "meaning" && q.type !== "usage") return [text];

  let target = null;
  let whole = false;
  const notes = [
    /（下線(?:部)?(?:は|：|:)?\s*「?([^」）]+?)」?）/,
    /（「([^」]+)」に下線）/,
  ];
  if (/（全体に下線）/.test(text)) { text = text.replace(/（全体に下線）/, ""); whole = true; }
  for (const re of notes) {
    const m = text.match(re);
    if (m) { target = m[1].trim(); text = text.replace(re, ""); break; }
  }
  const marked = text.match(/《([^》]+)》/);
  if (!target && marked) { target = marked[1]; text = text.replace(/《([^》]+)》/, "$1"); }
  if (!target && !whole) {
    const runs = text.replace(/[(（][^)）]*[)）]/g, (s) => "\u0000".repeat(s.length)).match(/[ァ-ヶ]+/g) || [];
    if (q.type === "usage" && runs.length) target = runs[runs.length - 1];
    else if (q.type === "usage") target = commonWord(text, q.options.map((o) => o.text));
    else if (q.type === "meaning" && runs.some((r) => r.length >= 3)) target = runs.filter((r) => r.length >= 3).pop();
    else if (q.type === "meaning") whole = true;
  }
  if (whole) return [el("span", { class: "ul", text })];
  const i = target ? text.lastIndexOf(target) : -1;
  if (i < 0) return [text];
  return [text.slice(0, i), el("span", { class: "ul", text: target }), text.slice(i + target.length)];
}

// 下線の印がない用法の問題は、選択肢の半分以上に出てくる最も長い語を下線の語とみなす（例: 留守をあずかる → あずかる）。
function commonWord(text, opts) {
  const need = Math.ceil(opts.length / 2);
  for (let len = Math.min(6, text.length); len >= 1; len--) {
    for (let i = 0; i + len <= text.length; i++) {
      const sub = text.slice(i, i + len);
      if (/[\s　、。]/.test(sub)) continue;
      if (opts.filter((o) => o.includes(sub)).length >= need) {
        // 頭の助詞（を・が・に など）は下線に含めない。助詞1字だけなら下線を引かない。
        const word = sub.length > 1 ? sub.replace(/^[をがにでは]/, "") : sub;
        return /^[をがにでのはも]$/.test(word) ? null : word;
      }
    }
  }
  return null;
}

let session = null;

function startQuiz(questions) {
  if (!questions.length) return;
  // 同じ本文の組問題（続けて並ぶ）は、1つの画面にまとめてタブで切り替える。
  const units = [];
  for (const q of questions) {
    const last = units[units.length - 1];
    if (q.group && last && last.qs[0].group === q.group) last.qs.push(q);
    else units.push({ qs: [q] });
  }
  const limitOf = (q) => (settings.seconds[q.type] || DATA.types[q.type].seconds) * 1000;
  for (const u of units) u.limitMs = u.qs.reduce((s, q) => s + limitOf(q), 0);
  session = {
    questions, units, unitIndex: 0, results: [], answered: 0, usedMs: 0,
    totalMs: units.reduce((s, u) => s + u.limitMs, 0),
  };
  show("quiz");
  renderUnit();
}

function initialAnswer(q) {
  return q.mode === "order" || q.mode === "text" ? "" : [];
}

function renderUnit() {
  const unit = session.units[session.unitIndex];
  session.cur = {
    unit, tab: 0, done: false,
    answers: unit.qs.map(initialAnswer),
    tabMs: unit.qs.map(() => 0),
    touched: unit.qs.map(() => false),
    tabStart: performance.now(),
  };
  $("q-feedback").hidden = true;
  $("q-submit").textContent = "次へ";
  window.scrollTo(0, 0);
  renderTab();
  startTimer(unit.limitMs);
  updateDonut(0);
}

function switchTab(i) {
  const cur = session.cur;
  if (i === cur.tab || i < 0 || i >= cur.unit.qs.length) return;
  const now = performance.now();
  if (!cur.done) cur.tabMs[cur.tab] += now - cur.tabStart;
  cur.tabStart = now;
  cur.tab = i;
  renderTab();
}

function renderTab() {
  const cur = session.cur;
  const q = cur.unit.qs[cur.tab];
  const before = session.units.slice(0, session.unitIndex).reduce((s, u) => s + u.qs.length, 0);
  $("q-progress").textContent = `${before + cur.tab + 1} / ${session.questions.length}　${DATA.types[q.type].label}`;
  $("q-instr").textContent = instrFor(q);

  const badge = $("q-group-badge");
  badge.hidden = cur.unit.qs.length < 2;
  badge.textContent = `この問題は${cur.unit.qs.length}問組です`;

  const passage = $("q-passage");
  passage.replaceChildren(...passageNodes(q));
  passage.className = "spi-passage" + (q.passage.length < 60 ? " short" : "");
  $("q-sub").textContent = q.optionKind === "kana" ? q.options.map((o) => `${o.key}　${o.text}`).join("\n") : "";

  const showPrompt = q.prompt && (q.type === "reading" || (q.type === "order" && q.mode !== "order") || q.type === "blank_passage");
  $("q-prompt").textContent = showPrompt ? q.prompt : "";

  const body = $("q-body");
  if (q.mode === "order") body.replaceChildren(renderOrder(q));
  else if (q.mode === "text") body.replaceChildren(renderText(q));
  else body.replaceChildren(renderChoices(q));
  if (cur.done) markAnswers(q);

  const tabs = $("q-tabs");
  tabs.hidden = cur.unit.qs.length < 2;
  tabs.replaceChildren(...cur.unit.qs.map((_, i) => {
    const cls = i === cur.tab ? "tab current" : cur.touched[i] || cur.done ? "tab done" : "tab";
    return el("button", { type: "button", class: cls, text: String(i + 1), onclick: () => switchTab(i) });
  }));
  $("q-body").closest(".answer-box").scrollTop = 0;
}

function renderChoices(q) {
  const cur = session.cur;
  const wrap = el("div", { class: "options" });
  const square = q.mode === "multi" && q.optionKind !== "kana";
  for (const o of choiceList(q)) {
    const btn = el("button", { class: "opt" + (square ? " square" : ""), type: "button", "data-key": o.key },
      el("span", { class: "mark" }), el("span", { class: "key", text: o.key }), el("span", { class: "txt", text: o.text }));
    btn.addEventListener("click", () => choose(o.key));
    wrap.append(btn);
  }
  const hint = square ? "あてはまるものをすべて選びます（もう一度押すと外れます）。" : "";
  setTimeout(() => paintChoices(q));
  return el("div", {}, wrap, hint ? el("div", { class: "hint", text: hint }) : null);
}

function isSelected(q, answer, key) {
  if (q.optionKind === "kana") return answer.length > 0 && sameSet(answer, KANA_COMBOS.find((c) => c.key === key).set);
  return answer.includes(key);
}

function paintChoices(q) {
  const ans = session.cur.answers[session.cur.tab];
  for (const b of document.querySelectorAll("#q-body .opt")) b.classList.toggle("selected", isSelected(q, ans, b.dataset.key));
}

function choose(key) {
  const cur = session.cur;
  if (cur.done) return;
  const q = cur.unit.qs[cur.tab];
  let a = cur.answers[cur.tab];
  if (q.optionKind === "kana") a = [...KANA_COMBOS.find((c) => c.key === key).set];
  else if (q.mode === "multi") a = a.includes(key) ? a.filter((k) => k !== key) : [...a, key];
  else a = [key];
  cur.answers[cur.tab] = a;
  cur.touched[cur.tab] = a.length > 0;
  paintChoices(q);
}

function renderOrder(q) {
  const cur = session.cur;
  const slots = el("div", { class: "order-slots" });
  const frags = el("div", { class: "options" });
  const n = q.options.length;
  const redraw = () => {
    const a = cur.answers[cur.tab];
    slots.replaceChildren(...Array.from({ length: n }, (_, i) =>
      el("div", { class: "slot" + (a[i] ? " filled" : ""), text: a[i] || "" })));
    for (const b of frags.children) b.classList.toggle("selected", a.includes(b.dataset.key));
  };
  for (const o of q.options) {
    const btn = el("button", { class: "opt", type: "button", "data-key": o.key },
      el("span", { class: "mark" }), el("span", { class: "key", text: o.key }), el("span", { class: "txt", text: o.text }));
    btn.addEventListener("click", () => pushOrder(o.key));
    frags.append(btn);
  }
  const edit = (f) => () => { if (!cur.done) { cur.answers[cur.tab] = f(cur.answers[cur.tab]); cur.touched[cur.tab] = cur.answers[cur.tab].length > 0; redraw(); } };
  cur.redraw = redraw;
  setTimeout(redraw);
  return el("div", {}, slots,
    el("div", { class: "row-buttons" },
      el("button", { type: "button", class: "small", text: "1つ戻す", onclick: edit((a) => a.slice(0, -1)) }),
      el("button", { type: "button", class: "small", text: "やり直す", onclick: edit(() => "") })),
    frags, el("div", { class: "hint", text: "文の頭にくるものから順に押します（数字キーでも入力できます）。" }));
}

function pushOrder(key) {
  const cur = session.cur;
  const q = cur.unit.qs[cur.tab];
  const a = cur.answers[cur.tab];
  if (cur.done || a.includes(key) || a.length >= q.options.length) return;
  cur.answers[cur.tab] = a + key;
  cur.touched[cur.tab] = true;
  cur.redraw();
}

function renderText() {
  const cur = session.cur;
  const input = el("input", { class: "text-answer", type: "text", autocomplete: "off", "aria-label": "答え" });
  input.value = cur.answers[cur.tab];
  input.disabled = cur.done;
  input.addEventListener("input", () => { cur.answers[cur.tab] = input.value; cur.touched[cur.tab] = input.value.length > 0; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && !e.repeat) { e.preventDefault(); next(); }
  });
  // パソコンだけ入力欄に移る（スマートフォンではキーボードが本文を隠すため）。
  if (window.matchMedia("(pointer: fine)").matches) setTimeout(() => { if (!cur.done) input.focus({ preventScroll: true }); });
  return el("div", {}, input, el("div", { class: "hint", text: "文中のことばをそのまま入力します。" }));
}

// ---- 回答時間のメーター（緑→黄→橙→赤のマス。赤まで進むと次へ） ----
const CELL_COLORS = ["g", "g", "g", "g", "g", "y", "y", "o", "o", "r"];
$("timer-cells").replaceChildren(...CELL_COLORS.map((c) => el("div", { class: `cell ${c}` }, el("b"))));

let audio = null;
function beep(freq, ms) {
  if (!settings.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(); const g = audio.createGain();
    o.type = "sine"; o.frequency.value = freq; g.gain.value = 0.05;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch { /* 音が出せない環境では鳴らさない */ }
}

function paintMeter(ratio) {
  const cells = $("timer-cells").children;
  for (let i = 0; i < cells.length; i++) {
    const f = Math.max(0, Math.min(1, ratio * cells.length - i));
    cells[i].firstChild.style.width = `${f * 100}%`;
  }
}

function updateDonut(unitElapsed) {
  const t = session.totalMs ? Math.min(1, (session.usedMs + unitElapsed) / session.totalMs) : 0;
  const a = session.questions.length ? session.answered / session.questions.length : 0;
  $("ring-time").style.strokeDasharray = `${t * 100} 100`;
  $("ring-answered").style.strokeDasharray = `${a * 100} 100`;
}

let timer = null;

function startTimer(limitMs) {
  stopTimer();
  const t0 = performance.now();
  let lastSecond = null;
  timer = { t0, limitMs, raf: 0 };
  paintMeter(0);
  $("timer-sec").className = "timer-sec";
  $("timer-sec").textContent = `0.0 秒 / ${limitMs / 1000} 秒`;
  const frame = () => {
    const elapsed = performance.now() - t0;
    const remain = limitMs - elapsed;
    paintMeter(elapsed / limitMs);
    updateDonut(Math.min(elapsed, limitMs));
    $("timer-sec").textContent = `${(elapsed / 1000).toFixed(1)} 秒 / ${limitMs / 1000} 秒`;
    if (remain > 0) {
      const sec = Math.ceil(remain / 1000);
      if (sec <= 5 && sec !== lastSecond) beep(sec <= 2 ? 1046 : 784, 60);
      lastSecond = sec;
    } else if (!$("timer-sec").classList.contains("over")) {
      $("timer-sec").classList.add("over");
      beep(330, 300);
      if (settings.auto) { submitUnit(true); return; }
    }
    timer.raf = requestAnimationFrame(frame);
  };
  timer.raf = requestAnimationFrame(frame);
}

function stopTimer() {
  if (!timer) return 0;
  cancelAnimationFrame(timer.raf);
  const elapsed = performance.now() - timer.t0;
  timer = null;
  return elapsed;
}

// ---- 回答 ----
// 次へ: 組問題では次のタブへ。最後の問題（または1問だけの画面）では回答を確定する。
function next() {
  const cur = session.cur;
  if (!cur) return;
  if (cur.done) return nextUnit();
  if (cur.tab < cur.unit.qs.length - 1) return switchTab(cur.tab + 1);
  submitUnit(false);
}

function submitUnit(timedOut) {
  const cur = session.cur;
  if (!cur || cur.done) return;
  const limitMs = timer ? timer.limitMs : cur.unit.limitMs;
  const elapsed = stopTimer();
  cur.tabMs[cur.tab] += performance.now() - cur.tabStart;
  cur.done = true;
  const over = timedOut || elapsed > limitMs;
  session.usedMs += Math.min(elapsed, limitMs);
  cur.unit.qs.forEach((q, i) => {
    const answer = cur.answers[i];
    const ms = cur.unit.qs.length === 1 ? elapsed : cur.tabMs[i];
    const r = { q, answer, ok: isCorrect(q, answer), ms: Math.round(ms), timedOut: over };
    session.results.push(r);
    record(r);
  });
  session.answered += cur.unit.qs.length;
  updateDonut(0);
  $("timer-sec").textContent = `${(elapsed / 1000).toFixed(1)} 秒 / ${limitMs / 1000} 秒${over ? "（時間切れ）" : ""}`;

  if (settings.mode === "practice") {
    renderTab();
    const rs = session.results.slice(-cur.unit.qs.length);
    $("q-feedback").replaceChildren(
      ...rs.map((r, i) => el("div", { class: "fb-item" },
        rs.length > 1 ? el("b", { text: `問${i + 1}` }) : null, ...feedbackNodes(r))),
      el("div", { class: "fb-actions" }, el("button", { class: "next-btn", type: "button", text: "次の問題へ", onclick: () => nextUnit() })));
    $("q-feedback").hidden = false;
    $("q-submit").textContent = session.unitIndex + 1 < session.units.length ? "次の問題へ" : "結果を見る";
    $("q-feedback").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else {
    nextUnit();
  }
}

function markAnswers(q) {
  const ans = session.cur.answers[session.cur.tab];
  for (const b of document.querySelectorAll("#q-body .opt")) {
    const k = b.dataset.key;
    let correct;
    if (q.mode === "order") correct = false;
    else if (q.optionKind === "kana") correct = q.accepted.some((a) => sameSet(a, KANA_COMBOS.find((c) => c.key === k).set));
    else correct = q.accepted.some((a) => a.includes(k));
    if (correct) b.classList.add("correct");
    else if (q.mode !== "order" && isSelected(q, ans, k)) b.classList.add("wrong");
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

function nextUnit() {
  session.unitIndex += 1;
  if (session.unitIndex >= session.units.length) return finish();
  renderUnit();
}

$("q-submit").addEventListener("click", () => next());
$("quit").addEventListener("click", () => { stopTimer(); finish(); });

document.addEventListener("keydown", (e) => {
  if ($("quiz").hidden || !session || !session.cur) return;
  if (e.target instanceof HTMLInputElement) return;
  const cur = session.cur;
  if (e.key === "Enter") { e.preventDefault(); if (!e.repeat) next(); return; }
  if (cur.done || e.metaKey || e.ctrlKey || e.altKey) return;
  const q = cur.unit.qs[cur.tab];
  if (q.mode === "order") {
    if (/^[1-9]$/.test(e.key) && q.options.some((o) => o.key === e.key)) pushOrder(e.key);
    if (e.key === "Backspace") { cur.answers[cur.tab] = cur.answers[cur.tab].slice(0, -1); cur.redraw(); }
    return;
  }
  if (q.mode !== "single" && q.mode !== "multi") return;
  const list = choiceList(q);
  let idx = -1;
  const k = e.key.toUpperCase();
  if (/^[A-H]$/.test(k)) idx = k.charCodeAt(0) - 65;
  else if (/^[1-8]$/.test(k)) idx = Number(k) - 1;
  if (idx >= 0 && idx < list.length) { e.preventDefault(); choose(list[idx].key); }
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
