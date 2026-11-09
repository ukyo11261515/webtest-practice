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
const SETTINGS_VERSION = 2;

function defaultSettings() {
  const seconds = {};
  for (const [k, t] of Object.entries(DATA.types)) seconds[k] = t.seconds;
  return {
    v: SETTINGS_VERSION, seconds, types: Object.keys(DATA.types), filter: "all", count: 20,
    order: "source", start: "first", startNumber: 1, resume: {}, mode: "exam", auto: true, sound: true,
  };
}

function loadSettings() {
  const d = defaultSettings();
  const s = store.get(KEY_SETTINGS, {});
  const merged = { ...d, ...s, seconds: { ...d.seconds, ...(s.seconds || {}) } };
  // 2026-11-09: 並び順の既定を問題集の順に変えた。古い設定（ランダム）は一度だけ問題集の順に戻す。
  if (s.v !== SETTINGS_VERSION) { merged.order = "source"; merged.v = SETTINGS_VERSION; }
  if (!merged.resume || typeof merged.resume !== "object") merged.resume = {};
  delete merged.resumeRow;
  return merged;
}

let settings = null;

function saveSettings() { store.set(KEY_SETTINGS, settings); }

function history() { return store.get(KEY_HISTORY, {}); }

// 前回の続きの位置は、選んだ種類と絞り込みの組み合わせごとに覚える（種類は問題集の中で混ざって並ぶため）。
const resumeKey = () => `${[...settings.types].sort().join(",")}|${settings.filter}`;
const resumeRow = () => settings.resume[resumeKey()] || 0;

const scoredOf = (k) => DATA.questions.filter((q) => q.type === k && q.scored);

function initHome() {
  settings = loadSettings();
  saveSettings();
  $("home-title").textContent = DATA.title;
  renderTypeChips();
  renderTypeTimes();
  $("opt-auto").checked = settings.auto;
  $("opt-sound").checked = settings.sound;
  refreshHome();
}

function renderTypeChips() {
  const hist = history();
  $("type-chips").replaceChildren(...Object.entries(DATA.types).map(([k, t]) => {
    const qs = scoredOf(k);
    const tried = qs.filter((q) => hist[q.id]);
    const n = tried.reduce((a, q) => a + hist[q.id].n, 0);
    const ok = tried.reduce((a, q) => a + hist[q.id].ok, 0);
    const done = `${tried.length}/${qs.length} 問済み`;
    const rate = n ? `正答率 ${Math.round((ok / n) * 100)}%` : "未回答";
    const chip = el("button", { type: "button", class: "chip", "data-type": k, "aria-pressed": "false" },
      el("span", { class: "chip-check" }),
      el("span", { class: "chip-body" },
        el("span", { class: "chip-title", text: t.label }),
        el("span", { class: "chip-meta", text: `${qs.length}問・${settings.seconds[k]}秒` }),
        el("span", { class: "chip-meta", text: `${done}・${rate}` })));
    chip.addEventListener("click", () => {
      settings.types = settings.types.includes(k) ? settings.types.filter((x) => x !== k) : [...settings.types, k];
      saveSettings(); refreshHome();
    });
    return chip;
  }));
}

function renderTypeTimes() {
  $("type-times").replaceChildren(...Object.entries(DATA.types).map(([k, t]) => {
    const box = el("input", { type: "number", min: "3", max: "600", step: "1", inputmode: "numeric", "data-type": k });
    box.value = settings.seconds[k];
    box.addEventListener("change", () => {
      const v = Math.max(3, Math.min(600, Math.round(Number(box.value) || t.seconds)));
      box.value = v; settings.seconds[k] = v; saveSettings(); renderTypeChips(); refreshHome();
    });
    return el("label", { class: "time-row" }, el("span", { text: t.label }), el("span", {}, box, " 秒"));
  }));
}

// 押しボタン式の選択（seg）の共通処理
function bindSeg(id, attr, key, parse = (v) => v) {
  for (const b of $(id).querySelectorAll("button")) {
    b.addEventListener("click", () => { settings[key] = parse(b.dataset[attr]); saveSettings(); refreshHome(); });
  }
}
function paintSeg(id, attr, value) {
  for (const b of $(id).querySelectorAll("button")) b.classList.toggle("on", String(b.dataset[attr]) === String(value));
}

bindSeg("count-seg", "count", "count", Number);
bindSeg("order-seg", "order", "order");
bindSeg("start-seg", "start", "start");
bindSeg("filter-seg", "filter", "filter");
bindSeg("mode-seg", "mode", "mode");
$("count-input").addEventListener("change", (e) => {
  const v = Math.round(Number(e.target.value));
  if (Number.isFinite(v) && v >= 1) { settings.count = Math.min(999, v); saveSettings(); }
  refreshHome(); // 空や0のときは、今の設定の表示に戻す
});
$("start-number").addEventListener("change", (e) => {
  settings.startNumber = Math.max(1, Math.round(Number(e.target.value) || 1));
  saveSettings(); refreshHome();
});
$("opt-auto").addEventListener("change", (e) => { settings.auto = e.target.checked; saveSettings(); });
$("opt-sound").addEventListener("change", (e) => { settings.sound = e.target.checked; saveSettings(); });
$("types-all").addEventListener("click", () => { settings.types = Object.keys(DATA.types); saveSettings(); refreshHome(); });
$("types-none").addEventListener("click", () => { settings.types = []; saveSettings(); refreshHome(); });
$("times-reset").addEventListener("click", () => {
  settings.seconds = defaultSettings().seconds; saveSettings(); renderTypeChips(); renderTypeTimes(); refreshHome();
});

function refreshHome() {
  for (const c of document.querySelectorAll("#type-chips .chip")) {
    const on = settings.types.includes(c.dataset.type);
    c.classList.toggle("on", on);
    c.setAttribute("aria-pressed", String(on));
  }
  paintSeg("count-seg", "count", [10, 20, 30, 50, 0].includes(settings.count) ? settings.count : "custom");
  $("count-input").value = [10, 20, 30, 50, 0].includes(settings.count) ? "" : settings.count;
  paintSeg("order-seg", "order", settings.order);
  paintSeg("start-seg", "start", settings.start);
  paintSeg("filter-seg", "filter", settings.filter);
  paintSeg("mode-seg", "mode", settings.mode);
  $("start-block").hidden = settings.order !== "source";
  $("start-number-wrap").hidden = settings.start !== "number";
  $("start-number").value = settings.startNumber;
  const resumeBtn = $("start-seg").querySelector('[data-start="resume"]');
  resumeBtn.disabled = !resumeRow();
  if (!resumeRow() && settings.start === "resume") paintSeg("start-seg", "start", "first");
  updateStartInfo();
}

function pool() {
  const hist = history();
  return DATA.questions.filter((q) => {
    if (!settings.types.includes(q.type) || !q.scored) return false;
    if (settings.filter === "wrong") return hist[q.id] && (hist[q.id].last !== true || hist[q.id].lastTimedOut);
    if (settings.filter === "new") return !hist[q.id];
    return true;
  });
}

// 問題集の順のときに、何番目から出すか（0 始まり）
function startIndex(qs) {
  if (settings.order !== "source" || !qs.length) return 0;
  let i = 0;
  if (settings.start === "number") i = Math.min(qs.length - 1, Math.max(0, settings.startNumber - 1));
  if (settings.start === "resume" && resumeRow()) {
    i = qs.findIndex((q) => q.row > resumeRow());
    if (i < 0) i = 0; // 最後まで解き終えていたら最初に戻る
  }
  // 長文の組の途中から始まらないように、組の先頭まで戻す。
  while (i > 0 && qs[i].group && qs[i - 1].group === qs[i].group) i--;
  return i;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 長文の3問組は、ばらさずに続けて出す。
function buildSet(qs) {
  const from = startIndex(qs);
  const ordered = qs.slice(from);
  const units = [];
  const byGroup = new Map();
  for (const q of ordered) {
    if (q.group) {
      if (!byGroup.has(q.group)) { byGroup.set(q.group, []); units.push(byGroup.get(q.group)); }
      byGroup.get(q.group).push(q);
    } else units.push([q]);
  }
  if (settings.order === "random") shuffle(units);
  const out = [];
  const limit = settings.count || Infinity;
  for (const u of units) { if (out.length >= limit) break; out.push(...u); }
  return { questions: out, from };
}

let lastPreview = [];

function updateStartInfo() {
  const qs = pool();
  const n = qs.length;
  const info = $("start-info");
  if (!settings.types.length) { info.textContent = "問題タイプを1つ以上選んでください"; $("start").disabled = true; return; }
  if (!n) { info.textContent = "条件に合う問題がありません"; $("start").disabled = true; return; }
  const preview = buildSet(qs);
  lastPreview = preview.questions;
  const m = preview.questions.length;
  const secs = preview.questions.reduce((s, q) => s + settings.seconds[q.type], 0);
  const where = settings.order === "source" ? `${preview.from + 1}〜${preview.from + m} 問目` : "ランダム";
  const min = secs >= 60 ? `最大 ${Math.floor(secs / 60)}分${secs % 60 ? `${secs % 60}秒` : ""}` : `最大 ${secs}秒`;
  info.replaceChildren(el("b", { text: `${m} 問` }), `（対象 ${n} 問中 ${where}）・${min}`);
  $("start").disabled = false;
}

$("start").addEventListener("click", () => startQuiz(lastPreview.length ? lastPreview : buildSet(pool()).questions));

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

  let target = q.underline || null;
  let whole = false;
  const notes = [
    /（下線(?:部)?(?:は|：|:)?\s*「?([^」）]+?)」?）/,
    /（「([^」]+)」に下線）/,
  ];
  if (/（全体に下線）/.test(text)) { text = text.replace(/（全体に下線）/, ""); whole = true; }
  for (const re of target ? [] : notes) {
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

function startQuiz(questions, retry = false) {
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
    questions, units, unitIndex: 0, results: [], answered: 0, usedMs: 0, retry,
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
  // 解き直しで組の一部だけを出すときも、元の組の問題数を出す（設問の「3問組の2問目」と合わせる）。
  const groupSize = q.group ? DATA.questions.filter((x) => x.group === q.group).length : 1;
  badge.hidden = groupSize < 2;
  badge.textContent = `この問題は${groupSize}問組です`;

  const passage = $("q-passage");
  passage.replaceChildren(...passageNodes(q));
  passage.className = "spi-passage" + (q.passage.length < 60 ? " short" : "");
  $("q-sub").textContent = q.optionKind === "kana" ? q.options.map((o) => `${o.key}　${o.text}`).join("\n") : "";

  $("q-prompt").textContent = promptFor(q);

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
  updateDonut(timer ? performance.now() - timer.t0 : 0);
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
  // 回答状況: 確定した問題に加えて、組問題の中ですでに答えた問題も数える。
  const cur = session.cur;
  const inUnit = cur && !cur.done && cur.unit.qs.length > 1 ? cur.touched.filter(Boolean).length : 0;
  const a = session.questions.length ? (session.answered + inUnit) / session.questions.length : 0;
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
      ...rs.map((r, i) => reviewCard(r, rs.length > 1 ? i + 1 : 0, true)),
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

// ---- 結果（答え合わせと解説） ----
const fmtSec = (ms) => (ms / 1000).toFixed(1);

function promptFor(q) {
  const show = q.prompt && (q.type === "reading" || (q.type === "order" && q.mode !== "order") || q.type === "blank_passage");
  return show ? q.prompt : "";
}

// 1問分の答え合わせのカード。compact は練習モード用（本文と選択肢は画面に出ているので省く）。
function reviewCard(r, no, compact = false) {
  const q = r.q;
  const cls = r.ok === null ? "na" : r.ok ? "ok" : "ng";
  const word = r.ok === null ? "採点なし" : r.ok ? "正解" : "不正解";
  const limit = settings.seconds[q.type];
  const card = el("article", { class: `rv rv-${cls}` });
  card.append(el("div", { class: "rv-head" },
    el("span", { class: `badge ${cls}`, text: word }),
    no ? el("span", { class: "rv-no", text: `問${no}` }) : null,
    el("span", { class: "rv-type", text: DATA.types[q.type].label }),
    el("span", { class: "rv-time" + (r.timedOut ? " over" : ""), text: `${fmtSec(r.ms)} 秒 / ${limit} 秒${r.timedOut ? "（時間切れ）" : ""}` })));

  if (!compact) {
    card.append(el("div", { class: "rv-instr", text: instrFor(q) }));
    const passage = el("div", { class: "rv-passage" + (q.passage.length < 60 ? " short" : "") }, ...passageNodes(q));
    if (q.passage.length >= 160) {
      const d = el("details", { class: "rv-more" }, el("summary", { text: "本文を表示" }), passage);
      card.append(d);
    } else card.append(passage);
    if (q.optionKind === "kana") card.append(el("div", { class: "rv-sub", text: q.options.map((o) => `${o.key}　${o.text}`).join("\n") }));
    const pr = promptFor(q);
    if (pr) card.append(el("div", { class: "rv-prompt", text: pr }));
  }

  if (q.mode === "single" || q.mode === "multi") {
    if (compact) card.append(answerLines(r));
    else {
      card.append(el("ul", { class: "rv-choices" }, ...choiceList(q).map((o) => {
        const correct = q.optionKind === "kana"
          ? q.accepted.some((a) => sameSet(a, o.set))
          : q.accepted.some((a) => a.includes(o.key));
        const mine = isSelected(q, r.answer, o.key);
        return el("li", { class: (correct ? "correct" : "") + (mine && !correct ? " wrong" : "") },
          el("span", { class: "key", text: o.key }), el("span", { class: "txt", text: o.text }),
          el("span", { class: "tags" },
            mine ? el("span", { class: "tag-mine", text: "あなた" }) : null,
            correct ? el("span", { class: "tag-ok", text: "正解" }) : null));
      })));
      if (!r.answer || r.answer.length === 0) card.append(el("p", { class: "rv-line muted", text: "あなたの答え: 無回答" }));
    }
  } else if (q.mode === "order") {
    if (!compact) card.append(el("ul", { class: "rv-choices plain" }, ...q.options.map((o) => el("li", {}, el("span", { class: "key", text: o.key }), el("span", { class: "txt", text: o.text })))));
    card.append(answerLines(r));
    if (q.accepted[0]) {
      const frag = q.accepted[0].split("").map((k) => (q.options.find((o) => o.key === k) || {}).text || "").join("");
      card.append(el("p", { class: "rv-line" }, el("b", { text: "正しい文: " }), q.passage.replace(/\s*12345\s*/, frag)));
    }
  } else {
    card.append(answerLines(r));
  }

  for (const n of q.notes) card.append(el("div", { class: "note", text: n }));
  if (q.explanation) card.append(el("div", { class: "rv-explain" }, el("div", { class: "rv-explain-label", text: "解説" }), el("div", { text: q.explanation })));
  return card;
}

function answerLines(r) {
  return el("div", { class: "rv-lines" },
    el("p", { class: "rv-line" }, el("b", { text: "あなたの答え: " }), answerLabel(r.q, r.answer)),
    el("p", { class: "rv-line" }, el("b", { text: "正解: " }), correctLabel(r.q)));
}

let resultFilter = "all";

function finish() {
  const rs = session.results;
  if (settings.order === "source" && rs.length && !session.retry) {
    settings.resume[resumeKey()] = Math.max(...rs.map((r) => r.q.row));
    saveSettings();
  }
  show("result");
  const scored = rs.filter((r) => r.ok !== null);
  const ok = scored.filter((r) => r.ok).length;
  const total = rs.reduce((s, r) => s + r.ms, 0);
  const pct = scored.length ? Math.round((ok / scored.length) * 100) : 0;
  const tout = rs.filter((r) => r.timedOut).length;
  $("r-score").replaceChildren(rs.length
    ? el("div", { class: "score-main" },
      el("div", { class: "score-pct", text: `${pct}%` }),
      el("div", { class: "score-sub" },
        el("div", { text: `${ok} / ${scored.length} 問正解` }),
        el("div", { class: "muted", text: `合計 ${fmtSec(total)} 秒・1問あたり ${fmtSec(total / rs.length)} 秒・時間切れ ${tout} 問` })))
    : el("div", { class: "muted", text: "回答した問題はありません" }));

  $("r-types").replaceChildren(...Object.entries(DATA.types).flatMap(([k, t]) => {
    const g = rs.filter((r) => r.q.type === k);
    if (!g.length) return [];
    const gs = g.filter((r) => r.ok !== null);
    const gok = gs.filter((r) => r.ok).length;
    const p = gs.length ? Math.round((gok / gs.length) * 100) : 0;
    const avg = g.reduce((s, r) => s + r.ms, 0) / g.length;
    return [el("div", { class: "tr-row" },
      el("div", { class: "tr-name", text: t.label }),
      el("div", { class: "tr-bar" }, el("i", { style: `width:${p}%` })),
      el("div", { class: "tr-num", text: `${gok}/${gs.length}（${p}%）` }),
      el("div", { class: "tr-time muted", text: `平均 ${fmtSec(avg)} 秒 / ${settings.seconds[k]} 秒` }))];
  }));
  resultFilter = "all";
  renderResultList();
  $("r-retry-wrong").disabled = !rs.some((r) => r.ok === false);
}

function renderResultList() {
  paintSeg("r-filter", "f", resultFilter);
  const items = session.results.map((r, i) => ({ r, i })).filter(({ r }) =>
    resultFilter === "ng" ? r.ok === false : resultFilter === "timeout" ? r.timedOut : true);
  $("r-list").replaceChildren(...(items.length
    ? items.map(({ r, i }) => reviewCard(r, i + 1))
    : [el("p", { class: "card muted", text: "該当する問題はありません。" })]));
}

for (const b of $("r-filter").querySelectorAll("button")) {
  b.addEventListener("click", () => { resultFilter = b.dataset.f; renderResultList(); });
}
$("r-home").addEventListener("click", () => { initHome(); show("home"); });
$("r-retry-wrong").addEventListener("click", () => {
  const wrong = session.results.filter((r) => r.ok === false).map((r) => r.q);
  startQuiz(wrong, true);
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
