'use strict';
(() => {
  const DECK = window.DECK;
  const ITEMS = DECK.items;
  const BY_ID = Object.fromEntries(ITEMS.map(x => [x.id, x]));
  const BY_N = Object.fromEntries(ITEMS.map(x => [x.n, x]));
  const LS_KEY = 'theory_recall_v1';
  const RING_C = 2 * Math.PI * 52;
  const NUM_RE = /(?:\d{1,4}|[〇一二三四五六七八九十百]{1,6})年|(?:[〇一二三四五六七八九十百]{1,3}|\d{1,2})个月|本世纪中叶/g;
  const PUNCT_CHAR_RE = /[\s，。；：、！？,.;:!?、“”‘’"'（）()《》〈〉【】\[\]{}—…·\-—_/\\|]/;

  const AI_PRESETS = {
    siliconflow: { name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V4-Flash' },
    deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    zhipu: { name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    custom: { name: '自定义', baseUrl: '', model: '' }
  };

  const DEFAULT_SETTINGS = {
    newLimit: 20,
    retention: 0.9,
    maxInterval: 60,
    theme: 'auto',
    ttsRate: 0.95,
    ai: {
      preset: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      key: '',
      auto: false
    }
  };

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const view = $('#view');
  const sheet = $('#sheet');
  const backdrop = $('#backdrop');
  const sessionEl = $('#session');
  const toastEl = $('#toast');
  const confettiEl = $('#confetti');

  let state = loadState();
  let engine = null;
  let currentTab = 'home';
  let session = null;
  let libQuery = '';
  let libFilter = 'all';
  let deferredPrompt = null;
  let toastTimer = null;
  let aiSaveTimer = null;
  let speechToken = 0;

  /* ------------------------------------------------------------------ utils */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  const pad = n => String(n).padStart(2, '0');
  const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayKey = () => dateKey(new Date());
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const daysDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / 86400000);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const weekdayCN = ['日', '一', '二', '三', '四', '五', '六'];

  function fmtDateCN(d = new Date()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 星期${weekdayCN[d.getDay()]}`;
  }
  function fmtDateTime(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDue(iso) {
    if (!iso) return '未学';
    const d = new Date(iso);
    const diff = daysDiff(d, new Date());
    if (diff < 0) return `逾期 ${-diff} 天`;
    if (diff === 0) return d.getTime() <= Date.now() ? '今天' : '今天稍后';
    if (diff === 1) return '明天';
    return `${diff} 天后`;
  }
  function fmtInterval(days) {
    if (days == null) return '—';
    if (days <= 0) return '今天';
    return `${days}天`;
  }
  function fmtDuration(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60), r = s % 60;
    return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
  }
  function shuffle(a) {
    const x = a.slice();
    for (let i = x.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [x[i], x[j]] = [x[j], x[i]];
    }
    return x;
  }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  /* ---------------------------------------------------------------- storage */
  function blankDay() {
    return { new: 0, rev: 0, again: 0, ok: 0, total: 0, ms: 0, scoreSum: 0, scoreCount: 0, skipped: 0 };
  }
  function blankState() {
    return {
      v: 1,
      cards: {},
      days: {},
      drafts: {},
      attempts: [],
      weak: {},
      wrong: {},
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      created: Date.now()
    };
  }
  function loadState() {
    const base = blankState();
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return base;
      const d = JSON.parse(raw);
      const s = {
        ...base,
        ...d,
        cards: d.cards || {},
        days: d.days || {},
        drafts: d.drafts || {},
        attempts: Array.isArray(d.attempts) ? d.attempts : [],
        weak: d.weak || {},
        wrong: d.wrong || {},
        settings: {
          ...base.settings,
          ...(d.settings || {}),
          ai: { ...base.settings.ai, ...((d.settings || {}).ai || {}) }
        }
      };
      return s;
    } catch (e) {
      return base;
    }
  }
  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      toast('本地存储空间不足，建议导出备份后清理');
      return false;
    }
  }
  function getDay(k = todayKey()) {
    if (!state.days[k]) state.days[k] = blankDay();
    const d = state.days[k];
    ['new', 'rev', 'again', 'ok', 'total', 'ms', 'scoreSum', 'scoreCount', 'skipped'].forEach(f => {
      if (typeof d[f] !== 'number') d[f] = 0;
    });
    return d;
  }

  /* ------------------------------------------------------------------- fsrs */
  function makeEngine() {
    return window.FSRS.fsrs({
      enable_short_term: false,
      enable_fuzz: true,
      maximum_interval: clamp(Number(state.settings.maxInterval) || 60, 7, 3650),
      request_retention: clamp(Number(state.settings.retention) || 0.9, 0.7, 0.99)
    });
  }
  function cardStored(id) { return state.cards[id]; }
  function isNew(id) {
    const c = state.cards[id];
    return !c || c.state === 0;
  }
  function cardObj(id) {
    const c = state.cards[id];
    if (!c) return null;
    return { ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined };
  }
  function serializeCard(c) {
    return {
      ...c,
      due: c.due instanceof Date ? c.due.toISOString() : c.due,
      last_review: c.last_review instanceof Date ? c.last_review.toISOString() : (c.last_review || undefined)
    };
  }
  function previewFor(id) {
    try {
      const base = cardObj(id) || window.FSRS.createEmptyCard(new Date());
      return engine.repeat(base, new Date());
    } catch (e) {
      return null;
    }
  }
  function dueItems() {
    const now = Date.now();
    return ITEMS.filter(x => {
      const c = state.cards[x.id];
      return c && c.state !== 0 && new Date(c.due).getTime() <= now;
    }).sort((a, b) => new Date(state.cards[a.id].due) - new Date(state.cards[b.id].due));
  }
  function newItems() {
    return ITEMS.filter(x => isNew(x.id));
  }
  function plan() {
    const day = getDay();
    return {
      due: Math.min(dueItems().length, 200),
      fresh: Math.min(newItems().length, Math.max(0, state.settings.newLimit - day.new))
    };
  }
  function learnedCount() { return ITEMS.filter(x => !isNew(x.id)).length; }
  function masteryLevel(id) {
    const c = state.cards[id];
    if (!c || c.state === 0) return 0;
    const d = c.scheduled_days || 0;
    if (d >= 14) return 3;
    if (d >= 3) return 2;
    return 1;
  }
  function masteryCounts() {
    const c = [0, 0, 0, 0];
    ITEMS.forEach(x => c[masteryLevel(x.id)]++);
    return c;
  }
  function avgScore() {
    let sum = 0, n = 0;
    Object.values(state.days).forEach(d => { sum += d.scoreSum || 0; n += d.scoreCount || 0; });
    return n ? Math.round(sum / n) : 0;
  }
  function streak() {
    let d = startOfDay(new Date());
    let k = dateKey(d);
    if (!((state.days[k]?.total || 0) > 0)) d = addDays(d, -1);
    let n = 0;
    for (let i = 0; i < 4000; i++) {
      k = dateKey(d);
      if ((state.days[k]?.total || 0) > 0) { n++; d = addDays(d, -1); }
      else break;
    }
    return n;
  }
  function totalAttempts() {
    return Object.values(state.days).reduce((a, d) => a + (d.total || 0), 0);
  }
  function lastAttempt(id) {
    return state.attempts.find(a => a.id === id) || null;
  }
  function topWeak(n = 6) {
    return Object.entries(state.weak)
      .map(([key, v]) => ({
        key, hit: v.hit || 0, miss: v.miss || 0,
        acc: (v.hit || 0) + (v.miss || 0) ? (v.hit || 0) / ((v.hit || 0) + (v.miss || 0)) : 0,
        last: v.last || 0
      }))
      .filter(x => x.miss > 0)
      .sort((a, b) => (b.miss - a.miss) || (a.acc - b.acc))
      .slice(0, n);
  }

  /* ------------------------------------------------------------------ icons */
  const ICON = {
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    speaker: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
    bulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.8.6 1.3 1.3 1.5 2.1h4c.2-.8.7-1.5 1.5-2.1A6 6 0 0 0 12 3z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    play: '<path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 5.5v16"/><path d="M8 7h8M8 10.5h6"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.7"/><path d="M20 4v7h-7"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
    upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 3h16"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
    arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    trophy: '<path d="M8 4h8v4a4 4 0 0 1-8 0z"/><path d="M8 5H5v2a3 3 0 0 0 3 3M16 5h3v2a3 3 0 0 1-3 3"/><path d="M12 12v5M9 21h6M10 17h4"/>'
  };
  function ico(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ''}</svg>`;
  }

  /* --------------------------------------------------------------- analysis */
  function normalizeChar(ch) {
    const c = ch.charCodeAt(0);
    if (c >= 0xFF01 && c <= 0xFF5E) return String.fromCharCode(c - 0xFEE0).toLowerCase();
    return ch.toLowerCase();
  }
  function normWithMap(s) {
    let out = '', map = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (PUNCT_CHAR_RE.test(ch)) continue;
      const n = normalizeChar(ch);
      if (!n) continue;
      out += n;
      map.push(i);
    }
    return { norm: out, map };
  }
  function lcsMark(a, b) {
    const n = a.length, m = b.length;
    const markA = new Uint8Array(n), markB = new Uint8Array(m);
    if (!n || !m) return { len: 0, markA, markB };
    if (n * m > 1500000) {
      let i = 0, j = 0, len = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) { markA[i] = 1; markB[j] = 1; i++; j++; len++; }
        else {
          const k = b.indexOf(a[i], j);
          if (k >= 0 && k - j <= 24) j = k;
          else i++;
        }
      }
      return { len, markA, markB };
    }
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = 1; i <= n; i++) {
      const ac = a.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        dp[i * w + j] = ac === b.charCodeAt(j - 1)
          ? dp[(i - 1) * w + j - 1] + 1
          : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1]);
      }
    }
    let i = n, j = m;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) { markA[i - 1] = 1; markB[j - 1] = 1; i--; j--; }
      else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) i--;
      else j--;
    }
    return { len: dp[n * w + m], markA, markB };
  }
  function greedyAlign(a, b) {
    const markA = new Uint8Array(a.length);
    const markB = new Uint8Array(b.length);
    let i = 0, len = 0;
    for (let j = 0; j < b.length; j++) {
      const idx = a.indexOf(b[j], i);
      if (idx >= 0) { markA[idx] = 1; markB[j] = 1; i = idx + 1; len++; }
    }
    return { len, markA, markB };
  }
  function longestMatch(a, b, aLo, aHi, bLo, bHi) {
    const m = bHi - bLo;
    if (m <= 0 || aHi <= aLo) return { i: aLo, j: bLo, size: 0 };
    const prev = new Uint16Array(m + 1);
    const cur = new Uint16Array(m + 1);
    let best = 0, bi = aLo, bj = bLo;
    for (let i = aLo; i < aHi; i++) {
      const ac = a[i];
      for (let j = bLo; j < bHi; j++) {
        if (ac === b[j]) {
          const v = prev[j - bLo] + 1;
          cur[j - bLo + 1] = v;
          if (v > best) { best = v; bi = i - v + 1; bj = j - v + 1; }
        } else cur[j - bLo + 1] = 0;
      }
      prev.set(cur);
      cur.fill(0);
    }
    return { i: bi, j: bj, size: best };
  }
  function blockAlign(a, b) {
    const markA = new Uint8Array(a.length);
    const markB = new Uint8Array(b.length);
    const blocks = [];
    function rec(aLo, aHi, bLo, bHi, depth) {
      if (depth > 80) return;
      const m = longestMatch(a, b, aLo, aHi, bLo, bHi);
      if (!m.size) return;
      if (aLo < m.i && bLo < m.j) rec(aLo, m.i, bLo, m.j, depth + 1);
      blocks.push(m);
      for (let k = 0; k < m.size; k++) { markA[m.i + k] = 1; markB[m.j + k] = 1; }
      if (m.i + m.size < aHi && m.j + m.size < bHi) rec(m.i + m.size, aHi, m.j + m.size, bHi, depth + 1);
    }
    rec(0, a.length, 0, b.length, 0);
    return { markA, markB, blocks };
  }
  function alignMarks(a, b) {
    if (!a.length || !b.length) return { markA: new Uint8Array(a.length), markB: new Uint8Array(b.length) };
    if (a.length > 900 || b.length > 900) return greedyAlign(a, b);
    return blockAlign(a, b);
  }
  function lcsSub(a, b) {
    if (!a || !b) return 0;
    let best = 0;
    const prev = new Uint16Array(b.length + 1);
    const cur = new Uint16Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        if (a[i - 1] === b[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        } else cur[j] = 0;
      }
      prev.set(cur);
      cur.fill(0);
    }
    return best;
  }
  function splitClauses(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if ('，。；'.includes(text[i])) {
        if (i > start) out.push({ s: start, e: i, text: text.slice(start, i) });
        start = i + 1;
      }
    }
    if (start < text.length) out.push({ s: start, e: text.length, text: text.slice(start) });
    return out;
  }
  function clauseMarks(ref, user, rNorm, uNorm) {
    const markA = new Uint8Array(rNorm.norm.length);
    const markB = new Uint8Array(uNorm.norm.length);
    const usedUser = new Uint8Array(user.length);
    let lastUserEnd = 0;
    for (const cl of splitClauses(ref)) {
      const cn = normWithMap(cl.text).norm;
      if (cn.length < 2) continue;
      let from = 0, found = -1;
      while (from <= uNorm.norm.length - cn.length) {
        const idx = uNorm.norm.indexOf(cn, from);
        if (idx < 0) break;
        const us = uNorm.map[idx];
        const ue = uNorm.map[idx + cn.length - 1] + 1;
        let overlap = false;
        for (let k = us; k < ue; k++) { if (usedUser[k]) { overlap = true; break; } }
        if (!overlap && us >= lastUserEnd) { found = idx; break; }
        from = idx + 1;
      }
      if (found < 0) continue;
      for (let k = 0; k < rNorm.norm.length; k++) {
        const oi = rNorm.map[k];
        if (oi >= cl.s && oi < cl.e) markA[k] = 1;
      }
      const us = uNorm.map[found];
      const ue = uNorm.map[found + cn.length - 1] + 1;
      for (let k = 0; k < uNorm.norm.length; k++) {
        const oi = uNorm.map[k];
        if (oi >= us && oi < ue) markB[k] = 1;
      }
      for (let k = us; k < ue; k++) usedUser[k] = 1;
      lastUserEnd = ue;
    }
    return { markA, markB };
  }
  function spansFromMark(normObj, mark) {
    const spans = [];
    let start = -1;
    for (let i = 0; i <= mark.length; i++) {
      const miss = i < mark.length && !mark[i];
      if (miss && start < 0) start = i;
      if (!miss && start >= 0) {
        const s = normObj.map[start];
        const e = normObj.map[i - 1] + 1;
        if (s != null && e > s) spans.push({ s, e });
        start = -1;
      }
    }
    return spans;
  }
  function markOriginal(text, spans, cls) {
    if (!spans.length) return esc(text).replace(/\n/g, '<br>');
    let html = '', pos = 0;
    for (const sp of spans) {
      if (sp.s > pos) html += esc(text.slice(pos, sp.s)).replace(/\n/g, '<br>');
      html += `<mark class="${cls}">${esc(text.slice(sp.s, sp.e)).replace(/\n/g, '<br>')}</mark>`;
      pos = Math.max(pos, sp.e);
    }
    html += esc(text.slice(pos)).replace(/\n/g, '<br>');
    return html;
  }
  function matchKey(key, userNorm) {
    const kn = normWithMap(key).norm;
    if (!kn || !userNorm) return { hit: false, ratio: 0 };
    if (userNorm.includes(kn)) return { hit: true, ratio: 1 };
    const sub = lcsSub(kn, userNorm);
    const ratio = kn.length ? sub / kn.length : 0;
    return { hit: ratio >= 0.82, ratio };
  }
  function mnemonic(item) {
    let chars = item.keyPoints.map(k => {
      const t = k.t.replace(/^坚持/, '');
      return (t[0] || k.t[0] || '');
    });
    if (new Set(chars).size < 2) chars = item.keyPoints.map(k => k.t.slice(-2));
    return chars.join('·');
  }
  function buildAdvice(item, res) {
    const out = [];
    const list = item.list || [];
    if (list.length >= 3 && list.length <= 8) {
      out.push(`结构：${list.length} 点并列。先按顺序记骨架：${list.join(' → ')}。`);
      out.push(`首字提示：${list.map(x => x.slice(0, 1)).join('、')}。`);
    } else if ((item.a.match(/（\d+）/g) || []).length >= 3) {
      out.push('结构：分条作答。先记住每条开头的主题词，再补后面的解释。');
    } else {
      const anchors = item.keyPoints.map(k => k.t).slice(0, 3);
      if (anchors.length) out.push(`先抓主干：${anchors.join(' → ')}。`);
    }
    if (res.missing.length) {
      out.push(`这次漏了：${res.missing.map(k => k.t).slice(0, 4).join('、')}。下一遍先补这几处，再通读全文。`);
    } else if (res.score >= 90) {
      out.push('要点齐全，隔天再默一遍即可。');
    }
    const nums = [...new Set([...res.numbers.missing, ...res.numbers.wrong])];
    if (nums.length) out.push(`数字单独记：${nums.join('、')}。把“主体—数字—事项”配成一组。`);
    if (item.keyPoints.length >= 3) out.push(`口诀（关键词）：${mnemonic(item)}。`);
    out.push('方法：合上答案先用自己的话复述骨架，再逐字默写；最后只看关键词检查。');
    return out;
  }
  function analyze(item, userText) {
    const ref = item.a;
    const user = userText || '';
    const r = normWithMap(ref);
    const u = normWithMap(user);
    const l = lcsMark(r.norm, u.norm);
    let g = clauseMarks(ref, user, r, u);
    if (!g.markA.some(Boolean) && !g.markB.some(Boolean)) g = alignMarks(r.norm, u.norm);
    const recall = r.norm.length ? l.len / r.norm.length : 0;
    const precision = u.norm.length ? l.len / u.norm.length : 0;
    const keys = item.keyPoints.map(k => {
      const m = matchKey(k.t, u.norm);
      return { ...k, hit: m.hit, ratio: m.ratio };
    });
    const hitCount = keys.filter(k => k.hit).length;
    const keyCov = keys.length ? hitCount / keys.length : 1;
    let score = 100 * (0.55 * recall + 0.15 * precision + 0.30 * keyCov);
    const refNums = [...ref.matchAll(NUM_RE)].map(m => m[0]);
    const userNums = [...user.matchAll(NUM_RE)].map(m => m[0]);
    const missingNums = [...new Set(refNums.filter(n => !userNums.includes(n)))];
    const wrongNums = [...new Set(userNums.filter(n => !refNums.includes(n)))];
    score -= Math.min(15, missingNums.length * 5);
    score -= Math.min(10, wrongNums.length * 3);
    if (!u.norm.length) score = 0;
    score = clamp(Math.round(score), 0, 100);
    const missing = keys.filter(k => !k.hit);
    const partial = keys.filter(k => !k.hit && k.ratio >= 0.45);
    const refSpans = u.norm.length ? spansFromMark(r, g.markA) : [];
    const userSpans = u.norm.length ? spansFromMark(u, g.markB) : [];
    return {
      score, recall, precision, keyCov,
      keys, missing, partial,
      numbers: { missing: missingNums, wrong: wrongNums },
      refHTML: markOriginal(ref, refSpans, 'miss'),
      userHTML: user ? markOriginal(user, userSpans, 'extra') : '',
      refSpans, userSpans,
      advice: buildAdvice(item, { score, missing, numbers: { missing: missingNums, wrong: wrongNums } })
    };
  }
  function scoreToRating(score) {
    if (score >= 95) return 4;
    if (score >= 78) return 3;
    if (score >= 50) return 2;
    return 1;
  }
  function scoreClass(score) {
    if (score >= 85) return 'good';
    if (score >= 60) return 'mid';
    return 'bad';
  }

  /* ------------------------------------------------------------------- HTML */
  function applyTheme() {
    const t = state.settings.theme;
    const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#141110' : '#9e1b22');
  }

  function streakChip() {
    $('#topStreak').textContent = streak();
  }

  function ringHTML(pct) {
    const off = RING_C * (1 - clamp(pct, 0, 1));
    return `<div class="ring-wrap">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="ring-bg" cx="60" cy="60" r="52" fill="none" stroke-width="8"/>
        <circle class="ring-fg" cx="60" cy="60" r="52" fill="none" stroke-width="8"
          stroke-linecap="round" stroke-dasharray="${RING_C.toFixed(1)}"
          stroke-dashoffset="${off.toFixed(1)}"/>
      </svg>
      <div class="ring-label"><b>${Math.round(pct * 100)}%</b><span>今日进度</span></div>
    </div>`;
  }

  function itemStatusPill(item) {
    const lv = masteryLevel(item.id);
    if (lv === 0) return '<span class="pill">未学</span>';
    if (lv === 1) return '<span class="pill gold">学习中</span>';
    if (lv === 2) return '<span class="pill blue">熟悉</span>';
    return '<span class="pill green">已掌握</span>';
  }

  function attemptRow(a) {
    const item = BY_ID[a.id];
    if (!item) return '';
    return `<button class="attempt-row" data-action="open-detail" data-id="${item.id}">
      <span class="attempt-score ${scoreClass(a.score)}">${a.skipped ? '未答' : a.score}</span>
      <span class="attempt-main"><b>第 ${item.n} 条 · ${esc(item.topic)}</b><small>${esc(item.q)}</small></span>
      <span class="attempt-time">${fmtDateTime(a.at)}</span>
    </button>`;
  }

  function homeHTML() {
    const day = getDay();
    const p = plan();
    const done = day.new + day.rev;
    const remain = p.due + p.fresh;
    const target = done + remain;
    const pct = target ? done / target : 1;
    const learned = learnedCount();
    const avg = avgScore();
    const st = streak();
    const weak = topWeak(3);
    const recent = state.attempts.slice(0, 3);
    const nextPool = [];
    dueItems().slice(0, 3).forEach(x => nextPool.push({ item: x, kind: '复习' }));
    newItems().slice(0, 3).forEach(x => nextPool.push({ item: x, kind: '新学' }));
    const next = nextPool.slice(0, 3);

    const hero = remain > 0
      ? `<h2>还有 <span style="color:#f4d9a6">${remain}</span> 条待默写</h2>
         <p>待复习 ${p.due} 条 · 待新学 ${p.fresh} 条</p>
         <button class="btn" data-action="start-session">开始今日默写 ${ico('arrow')}</button>`
      : `<h2>今天的任务完成了</h2>
         <p>可以去随机抽背，或专门重默薄弱条目。</p>
         <button class="btn" data-action="practice-random">随机抽背 10 题 ${ico('arrow')}</button>`;

    return `
    <div class="home-head">
      <div><h1>${greeting()}，今天也背一点</h1><p>${fmtDateCN()} · 共 95 条 · FSRS 间隔复习</p></div>
    </div>
    <section class="hero">
      <div class="hero-top"><span>今日默写</span><span>${done} / ${target || done || 0}</span></div>
      <div class="hero-main">
        ${ringHTML(pct)}
        <div class="hero-copy">${hero}</div>
      </div>
      <div class="hero-foot">
        <span>已默写 <b>${done}</b> 条</span>
        <span>平均 <b>${avg || '—'}</b> 分</span>
        <span>连续 <b>${st}</b> 天</span>
      </div>
    </section>
    <div class="stat-strip">
      <div class="stat-mini"><b>${learned}<small style="font-size:11px;color:var(--muted)">/95</small></b><span>已学条目</span></div>
      <div class="stat-mini gold"><b>${avg || '—'}</b><span>平均得分</span></div>
      <div class="stat-mini red"><b>${st}</b><span>连续天数</span></div>
    </div>
    <div class="section-title"><h2>今日安排</h2><span>${remain ? '按计划来' : '已完成'}</span></div>
    <div class="card plan-card">
      <div class="plan-row">
        <div class="plan-ico">${ico('refresh')}</div>
        <div class="plan-main"><b>复习到期</b><span>先默写，再看批改和记忆建议</span></div>
        <div class="plan-num">${p.due}</div>
      </div>
      <div class="plan-row">
        <div class="plan-ico gold">${ico('spark')}</div>
        <div class="plan-main"><b>学习新条目</b><span>今日还可学 ${Math.max(0, state.settings.newLimit - day.new)} 条</span></div>
        <div class="plan-num gold">${p.fresh}</div>
      </div>
    </div>
    ${next.length ? `<div class="section-title"><h2>接下来</h2><span>点一条直接默写</span></div>
    <div class="card next-list">
      ${next.map(x => `<button class="next-item" data-action="study-one" data-id="${x.item.id}">
        <span class="next-num">${x.item.n}</span>
        <span class="next-q">${esc(x.item.q)}<span class="next-meta"><span class="pill ${x.kind === '新学' ? 'gold' : 'red'}">${x.kind}</span><span class="dot"></span>${esc(x.item.sec)}</span></span>
      </button>`).join('')}
    </div>` : ''}
    ${weak.length ? `<div class="section-title"><h2>薄弱要点</h2><span>点一下专项重默</span></div>
    <div class="card weak-card">
      ${weak.map(w => `<button class="weak-row" data-action="weak-start" data-key="${encodeURIComponent(w.key)}">
        <span class="weak-key">${esc(w.key)}</span>
        <span class="weak-meta">漏 ${w.miss} 次 · 命中率 ${Math.round(w.acc * 100)}%</span>
      </button>`).join('')}
    </div>` : ''}
    ${recent.length ? `<div class="section-title"><h2>最近批改</h2><span>共 ${state.attempts.length} 次</span></div>
    <div class="card attempt-list">${recent.map(attemptRow).join('')}</div>` : ''}
    <div class="foot-note">默写比反复看答案更有效：先回忆，再对照，最后看记忆建议。</div>`;
  }
  function greeting() {
    const h = new Date().getHours();
    if (h < 6) return '夜深了';
    if (h < 12) return '早上好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  function practiceHTML() {
    const p = plan();
    const remain = p.due + p.fresh;
    const wrongIds = Object.keys(state.wrong).filter(id => state.wrong[id]?.count > 0);
    const weak = topWeak(8);
    const recent = state.attempts.slice(0, 5);
    const avg = avgScore();
    const total = totalAttempts();
    return `
    <div class="page-head"><h1>默写训练</h1><p>每次默写都会批改、给建议，并更新复习计划。</p></div>
    <div class="mode-grid">
      <button class="mode-card" data-action="start-session">
        <span class="mode-ico red">${ico('pen')}</span>
        <span class="mode-main"><h3>今日默写</h3><p>到期复习 + 今日新学，按 FSRS 安排</p><span class="rec">${remain ? `还剩 ${remain} 条` : '今天已完成'}</span></span>
        <span class="chev">${ico('chevron')}</span>
      </button>
      <button class="mode-card" data-action="practice-random">
        <span class="mode-ico gold">${ico('zap')}</span>
        <span class="mode-main"><h3>随机抽背</h3><p>从 95 条中抽 10 条，适合碎片时间</p><span class="rec">会更新复习计划</span></span>
        <span class="chev">${ico('chevron')}</span>
      </button>
      <button class="mode-card" data-action="practice-wrong">
        <span class="mode-ico green">${ico('refresh')}</span>
        <span class="mode-main"><h3>错题重默</h3><p>默写得分低或评过“忘记”的条目</p><span class="rec">当前 ${wrongIds.length} 条</span></span>
        <span class="chev">${ico('chevron')}</span>
      </button>
    </div>
    <div class="stat-strip">
      <div class="stat-mini gold"><b>${avg || '—'}</b><span>平均得分</span></div>
      <div class="stat-mini"><b>${total}</b><span>累计默写</span></div>
      <div class="stat-mini red"><b>${wrongIds.length}</b><span>错题条目</span></div>
    </div>
    ${weak.length ? `<div class="section-title"><h2>薄弱要点</h2><span>按遗漏次数排序</span></div>
    <div class="card weak-card">
      ${weak.map(w => `<button class="weak-row" data-action="weak-start" data-key="${encodeURIComponent(w.key)}">
        <span class="weak-key">${esc(w.key)}</span>
        <span class="weak-meta">漏 ${w.miss} 次 · 命中率 ${Math.round(w.acc * 100)}%</span>
      </button>`).join('')}
    </div>` : `<div class="card empty-card"><b>还没有薄弱要点</b><p>默写几题后，这里会自动统计你最常漏掉的关键词。</p></div>`}
    ${recent.length ? `<div class="section-title"><h2>最近批改</h2><span>点开看原文</span></div>
    <div class="card attempt-list">${recent.map(attemptRow).join('')}</div>` : ''}
    <div class="foot-note">建议先做“今日默写”，再用“随机抽背”加练。</div>`;
  }

  function libMatches(item) {
    if (libQuery) {
      const q = libQuery.toLowerCase();
      if (!(item.q + item.a + item.topic + item.sec).toLowerCase().includes(q)) return false;
    }
    const lv = masteryLevel(item.id);
    const last = lastAttempt(item.id);
    if (libFilter === 'base') return item.sec === '基础理论';
    if (libFilter === 'new') return item.sec === '新时代';
    if (libFilter === 'unlearned') return lv === 0;
    if (libFilter === 'learning') return lv === 1;
    if (libFilter === 'mastered') return lv === 3;
    if (libFilter === 'wrong') return (state.wrong[item.id]?.count > 0) || (last && last.score < 60);
    return true;
  }
  function libListHTML() {
    const items = ITEMS.filter(libMatches);
    if (!items.length) return `<div class="empty">${ico('search')}<div>没有找到匹配的条目</div></div>`;
    return items.map(item => {
      const lv = masteryLevel(item.id);
      const last = lastAttempt(item.id);
      const dot = ['', 'learning', 'familiar', 'mastered'][lv];
      const due = state.cards[item.id] ? fmtDue(state.cards[item.id].due) : '未学';
      return `<button class="lib-row" data-action="open-detail" data-id="${item.id}">
        <span class="lib-num">${item.n}</span>
        <span class="lib-main">
          <span class="lib-q">${esc(item.q)}</span>
          <span class="lib-meta">
            <i class="lib-dot ${dot}"></i>${esc(item.sec)}
            <span class="dot"></span>${due}
            ${last ? `<span class="dot"></span><span class="${last.score >= 78 ? 'ok-text' : 'bad-text'}">上次 ${last.score} 分</span>` : ''}
          </span>
        </span>
      </button>`;
    }).join('');
  }
  function libraryHTML() {
    const filters = [
      ['all', '全部'], ['base', '基础理论'], ['new', '新时代'], ['unlearned', '未学'],
      ['learning', '学习中'], ['mastered', '已掌握'], ['wrong', '易错']
    ];
    return `
    <div class="page-head"><h1>题库</h1><p>95 条原文，按篇章筛选，点开可单条默写。</p></div>
    <div class="searchbar">${ico('search')}<input id="libSearch" placeholder="搜索题目或答案关键词" value="${esc(libQuery)}"></div>
    <div class="filters">${filters.map(([k, n]) => `<button class="filter ${libFilter === k ? 'active' : ''}" data-action="lib-filter" data-filter="${k}">${n}</button>`).join('')}</div>
    <div class="lib-count" id="libCount"></div>
    <div class="lib-list" id="libListWrap">${libListHTML()}</div>`;
  }
  function refreshLibCount() {
    const c = ITEMS.filter(libMatches).length;
    const el = $('#libCount');
    if (el) el.textContent = `共 ${c} 条`;
  }

  function heatHTML() {
    let start = addDays(startOfDay(new Date()), -83);
    const dow = (start.getDay() + 6) % 7;
    start = addDays(start, -dow);
    const cells = [];
    for (let i = 0; i < 84; i++) {
      const d = addDays(start, i);
      const k = dateKey(d);
      const v = state.days[k]?.total || 0;
      const lv = v === 0 ? 0 : v <= 2 ? 1 : v <= 5 ? 2 : v <= 9 ? 3 : 4;
      cells.push(`<i class="${lv ? 'l' + lv : ''}" title="${k} · ${v} 次"></i>`);
    }
    return `<div class="heat">${cells.join('')}</div>
      <div class="heat-legend"><span>少</span><i></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span>多</span></div>`;
  }
  function trendHTML() {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(new Date(), -i);
      const k = dateKey(d);
      const day = state.days[k];
      const score = day && day.scoreCount ? Math.round(day.scoreSum / day.scoreCount) : 0;
      days.push({ d, score, label: i === 0 ? '今天' : `周${weekdayCN[d.getDay()]}` });
    }
    const max = 100;
    return `<div class="trend">${days.map(x => `<div class="tcol" title="${dateKey(x.d)} · ${x.score || '无'} 分">
      <b>${x.score || ''}</b>
      <div class="tbar-wrap"><i class="tbar" style="height:${Math.max(3, x.score / max * 100)}%;opacity:${x.score ? 1 : .18}"></i></div>
      <span>${x.label}</span>
    </div>`).join('')}</div>`;
  }
  function meHTML() {
    const m = masteryCounts();
    const learned = learnedCount();
    const avg = avgScore();
    const st = streak();
    const total = totalAttempts();
    const weak = topWeak(8);
    const aiOn = !!(state.settings.ai.key && state.settings.ai.auto);
    return `
    <div class="page-head"><h1>我的</h1><p>所有数据只保存在这台设备的浏览器里。</p></div>
    <div class="card profile">
      <div class="avatar">理</div>
      <div><h2>理论记忆 · 个人版</h2><p>已坚持 ${st} 天 · 累计默写 ${total} 次</p></div>
    </div>
    <div class="me-stats">
      <div class="me-stat"><b>${learned}<small style="font-size:11px;color:var(--muted)">/95</small></b><span>已学条目</span></div>
      <div class="me-stat gold"><b>${avg || '—'}</b><span>平均得分</span></div>
      <div class="me-stat green"><b>${Math.round(m[3] / ITEMS.length * 100)}%</b><span>掌握率</span></div>
      <div class="me-stat red"><b>${st}</b><span>连续天数</span></div>
    </div>
    <div class="section-title"><h2>学习热力</h2><span>最近 12 周</span></div>
    <div class="card heat-wrap">${heatHTML()}</div>
    <div class="section-title"><h2>近 7 天平均分</h2><span>只看有默写的日子</span></div>
    <div class="card">${trendHTML()}</div>
    <div class="section-title"><h2>掌握分布</h2><span>按复习间隔</span></div>
    <div class="card">
      <div class="mastery-bar">
        <i style="width:${m[0] / ITEMS.length * 100}%;background:var(--line-strong)"></i>
        <i style="width:${m[1] / ITEMS.length * 100}%;background:var(--amber)"></i>
        <i style="width:${m[2] / ITEMS.length * 100}%;background:var(--blue)"></i>
        <i style="width:${m[3] / ITEMS.length * 100}%;background:var(--green)"></i>
      </div>
      <div class="mastery-legend">
        <span><b style="background:var(--line-strong)"></b>未学 ${m[0]}</span>
        <span><b style="background:var(--amber)"></b>学习中 ${m[1]}</span>
        <span><b style="background:var(--blue)"></b>熟悉 ${m[2]}</span>
        <span><b style="background:var(--green)"></b>已掌握 ${m[3]}</span>
      </div>
    </div>
    ${weak.length ? `<div class="section-title"><h2>薄弱要点</h2><span>点一下专项重默</span></div>
    <div class="card weak-card">${weak.map(w => `<button class="weak-row" data-action="weak-start" data-key="${encodeURIComponent(w.key)}">
      <span class="weak-key">${esc(w.key)}</span><span class="weak-meta">漏 ${w.miss} 次 · 命中率 ${Math.round(w.acc * 100)}%</span>
    </button>`).join('')}</div>` : ''}
    <div class="section-title"><h2>设置</h2><span>按自己的节奏</span></div>
    <div class="card settings-card">
      <button class="set-action" data-action="settings-open"><span>复习计划与外观</span><span class="chev">${ico('chevron')}</span></button>
      <button class="set-action" data-action="ai-settings"><span>AI 深度点评 <span class="pill ${state.settings.ai.key ? 'green' : ''}">${state.settings.ai.key ? (aiOn ? '自动' : '已配置') : '未配置'}</span></span><span class="chev">${ico('chevron')}</span></button>
      <button class="set-action" data-action="export"><span>导出备份</span><span class="chev">${ico('download')}</span></button>
      <button class="set-action" data-action="import"><span>导入备份</span><span class="chev">${ico('upload')}</span></button>
      <button class="set-action" data-action="about-open"><span>关于与数据来源</span><span class="chev">${ico('info')}</span></button>
      <button class="set-action set-danger" data-action="reset"><span>清空全部进度</span><span class="chev">${ico('trash')}</span></button>
    </div>
    <button class="btn btn-block" data-action="install" style="margin-top:12px">添加到主屏幕</button>
    <div class="foot-note">数据仅存本机 · 建议每周导出一次备份<br>算法：FSRS 4.5 · 参考 Anki / 词光 / qwerty-learner</div>`;
  }

  /* ------------------------------------------------------------------ views */
  function render() {
    applyTheme();
    streakChip();
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
    if (currentTab === 'home') view.innerHTML = homeHTML();
    else if (currentTab === 'practice') view.innerHTML = practiceHTML();
    else if (currentTab === 'library') {
      view.innerHTML = libraryHTML();
      refreshLibCount();
      const input = $('#libSearch');
      if (input) {
        input.addEventListener('input', () => {
          libQuery = input.value;
          $('#libListWrap').innerHTML = libListHTML();
          refreshLibCount();
        });
      }
    } else view.innerHTML = meHTML();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  /* ---------------------------------------------------------------- sheets */
  function openSheet(html) {
    sheet.innerHTML = `<div class="sheet-handle"></div>${html}`;
    sheet.classList.add('open');
    backdrop.classList.add('open');
    sheet.scrollTop = 0;
  }
  function closeSheet() {
    if (document.getElementById('aiKey')) saveAISettings();
    sheet.classList.remove('open');
    backdrop.classList.remove('open');
    setTimeout(() => { if (!sheet.classList.contains('open')) sheet.innerHTML = ''; }, 260);
  }
  function detailHTML(item) {
    const c = state.cards[item.id];
    const last = lastAttempt(item.id);
    const card = cardObj(item.id);
    let retrievability = '—';
    if (card && card.state !== 0) {
      try { retrievability = engine.get_retrievability(card, new Date(), true); } catch (e) { retrievability = '—'; }
    }
    return `<div class="sheet-head">
      <div><h2>第 ${item.n} 条 · ${esc(item.topic)}</h2><p>${esc(item.sec)}</p></div>
      <button class="sheet-close" data-action="close-sheet">${ico('x')}</button>
    </div>
    <div class="detail-q">${esc(item.q)}</div>
    <div class="detail-a">${segHTML(item)}</div>
    <div class="detail-keys">${item.keyPoints.map(k => `<span>${esc(k.t)}</span>`).join('')}</div>
    <div class="srs-grid">
      <div><b>${c ? fmtDue(c.due) : '未学'}</b><span>下次复习</span></div>
      <div><b>${c ? (c.scheduled_days || 0) + ' 天' : '—'}</b><span>当前间隔</span></div>
      <div><b>${retrievability}</b><span>记忆保持率</span></div>
      <div><b>${c ? (c.reps || 0) : 0}</b><span>复习次数</span></div>
      <div><b>${c ? (c.lapses || 0) : 0}</b><span>遗忘次数</span></div>
      <div><b>${last ? last.score + ' 分' : '—'}</b><span>上次得分</span></div>
    </div>
    ${last ? `<div class="last-attempt">上次默写 ${fmtDateTime(last.at)} · ${last.skipped ? '未作答' : last.score + ' 分'}${last.missing?.length ? ` · 漏：${esc(last.missing.slice(0, 3).join('、'))}` : ''}</div>` : ''}
    <div class="detail-actions">
      <button class="btn btn-primary" data-action="study-one" data-id="${item.id}">${ico('pen')}默写这一条</button>
      <button class="btn" data-action="speak-detail" data-id="${item.id}">${ico('speaker')}朗读</button>
    </div>`;
  }
  function openDetail(id) {
    const item = BY_ID[id];
    if (!item) return;
    openSheet(detailHTML(item));
  }
  function segHTML(item) {
    return item.seg.map(s => {
      if ('t' in s) return esc(s.t).replace(/\n/g, '<br>');
      return `<mark class="k">${esc(s.b)}</mark>`;
    }).join('');
  }

  function settingsHTML() {
    const s = state.settings;
    return `<div class="sheet-head">
      <div><h2>复习计划与外观</h2><p>修改后立即生效</p></div>
      <button class="sheet-close" data-action="close-sheet">${ico('x')}</button>
    </div>
    <div class="settings-sheet">
      <h3>每日新学</h3>
      <div class="set-row">
        <div class="set-main"><b>${s.newLimit} 条 / 天</b><span>95 条约 ${Math.ceil(95 / Math.max(1, s.newLimit))} 天学完第一轮</span></div>
        <div class="stepper">
          <button data-action="new-limit" data-delta="-5">−</button>
          <b>${s.newLimit}</b>
          <button data-action="new-limit" data-delta="5">+</button>
        </div>
      </div>
      <h3>目标记忆率</h3>
      <div class="set-row">
        <div class="set-main"><b>${Math.round(s.retention * 100)}%</b><span>越高，复习安排越频繁</span></div>
        <div class="seg">${[0.8, 0.85, 0.9, 0.95].map(v => `<button data-action="retention" data-v="${v}" class="${+s.retention === v ? 'on' : ''}">${Math.round(v * 100)}%</button>`).join('')}</div>
      </div>
      <h3>最长复习间隔</h3>
      <div class="set-row">
        <div class="set-main"><b>${s.maxInterval} 天</b><span>到考试前，建议 60 天以内</span></div>
        <div class="seg">${[30, 60, 120, 365].map(v => `<button data-action="max-interval" data-v="${v}" class="${+s.maxInterval === v ? 'on' : ''}">${v}天</button>`).join('')}</div>
      </div>
      <h3>深色模式</h3>
      <div class="set-row">
        <div class="set-main"><b>外观</b><span>跟随系统或手动切换</span></div>
        <div class="seg">${[['auto', '自动'], ['light', '浅色'], ['dark', '深色']].map(([v, n]) => `<button data-action="theme" data-v="${v}" class="${s.theme === v ? 'on' : ''}">${n}</button>`).join('')}</div>
      </div>
      <h3>AI 点评</h3>
      <button class="set-action" data-action="ai-settings"><span>API 接口设置</span><span class="chev">${ico('chevron')}</span></button>
    </div>
    <div class="foot-note">FSRS 会根据每次评级调整下次复习时间；建议按提示评级，不必追求“全对”。</div>`;
  }

  function aiSettingsHTML() {
    const ai = state.settings.ai;
    return `<div class="sheet-head">
      <div><h2>AI 深度点评</h2><p>可选功能；不配置也能用本地批改</p></div>
      <button class="sheet-close" data-action="close-sheet">${ico('x')}</button>
    </div>
    <div class="ai-note">需要自备一个可用的 API Key（有余额/额度）。Key 只保存在本机浏览器，不会写进网页代码，也不会随导出备份一起导出；请求直接发往你填写的接口。</div>
    <div class="settings-sheet">
      <h3>接口预设</h3>
      <div class="preset-row">
        ${Object.entries(AI_PRESETS).map(([k, v]) => `<button class="preset ${ai.preset === k ? 'on' : ''}" data-action="ai-preset" data-preset="${k}">${v.name}</button>`).join('')}
      </div>
      <label class="field"><span>Base URL</span><input id="aiBase" autocomplete="off" spellcheck="false" value="${esc(ai.baseUrl)}" placeholder="https://api.example.com/v1"></label>
      <label class="field"><span>模型</span><input id="aiModel" autocomplete="off" spellcheck="false" value="${esc(ai.model)}" placeholder="model-name"></label>
      <label class="field"><span>API Key</span>
        <div class="ai-key-row"><input id="aiKey" type="password" autocomplete="off" spellcheck="false" value="${esc(ai.key)}" placeholder="sk-..."><button class="btn btn-sm" data-action="toggle-key">显示</button></div>
      </label>
      <label class="switch-row"><span><b>提交后自动点评</b><small>会额外消耗接口额度</small></span><input type="checkbox" id="aiAuto" ${ai.auto ? 'checked' : ''}></label>
      <div class="sheet-actions">
        <button class="btn" data-action="ai-test">测试连接</button>
        <button class="btn btn-primary" data-action="ai-done">完成</button>
      </div>
      <button class="set-action set-danger" data-action="ai-clear" style="margin-top:6px"><span>清除本机 Key</span><span class="chev">${ico('trash')}</span></button>
    </div>
    <div class="foot-note">如果接口不支持浏览器直连（CORS），会提示网络失败；可换用支持 CORS 的接口。公开网页不要写死 Key，否则会被盗刷。</div>`;
  }

  function aboutHTML() {
    return `<div class="sheet-head">
      <div><h2>关于</h2><p>数据、算法与来源</p></div>
      <button class="sheet-close" data-action="close-sheet">${ico('x')}</button>
    </div>
    <div class="about">
      <p><b>这是什么</b><br>把《党的基本理论知识篇》的 95 个问答做成默写卡：先凭记忆写，再自动对照原文，标出漏写和写错的地方，给出记忆建议，并按 FSRS 安排下次复习。</p>
      <p><b>批改方式</b><br>本地批改不联网：按“字符覆盖率 + 要点命中 + 数字检查”打分，红色标出与原文文字不一致的地方。红色不一定代表意思错，只代表和原文表述不同。</p>
      <p><b>AI 点评</b><br>可选。填入兼容 OpenAI 格式的接口地址、模型和 Key 后，可把当前题目、标准答案和你的默写发给模型做更细的点评。Key 只存本机。</p>
      <p><b>算法</b><br>FSRS 4.5（Free Spaced Repetition Scheduler），根据“忘记 / 模糊 / 记得 / 太简单”四级评级计算稳定度和难度；本地内置的是 <a href="https://github.com/open-spaced-repetition/ts-fsrs" target="_blank" rel="noopener">ts-fsrs</a> 4.7.1 的浏览器版本。</p>
      <p><b>交互参考</b><br><span class="tag">Anki</span><span class="tag">词光 Word Atlas</span><span class="tag">qwerty-learner</span> 的每日任务、间隔复习和移动端卡片思路。</p>
      <p><b>内容来源</b><br>你提供的《党的基本理论知识篇》docx，共 95 条。只修正了明显笔误：“红红脸、出汗汗”改为“红红脸、出出汗”。其余按原文保留。</p>
      <p><b>隐私</b><br>学习记录只存在本机 localStorage；没有账号、没有服务器。换手机或清缓存前，请在“我的”里导出备份。</p>
      <p style="font-size:11px">版本 1.0 · 2026-11-05</p>
    </div>`;
  }

  /* ---------------------------------------------------------------- session */
  function buildSRSQueue() {
    const due = dueItems();
    const fresh = newItems().slice(0, Math.max(0, state.settings.newLimit - getDay().new));
    const q = [];
    let i = 0, j = 0;
    while (i < due.length || j < fresh.length) {
      for (let k = 0; k < 3 && i < due.length; k++) q.push({ id: due[i++].id, isNew: false });
      if (j < fresh.length) q.push({ id: fresh[j++].id, isNew: true });
    }
    return q;
  }
  function startQueue(queue, mode = 'srs') {
    if (!queue.length) {
      toast('没有可默写的条目');
      return;
    }
    session = {
      mode,
      queue,
      total: queue.length,
      done: 0,
      replay: [],
      current: null,
      start: Date.now(),
      cardStart: Date.now(),
      userAnswer: '',
      submitted: false,
      result: null,
      suggested: null,
      ai: '',
      aiError: '',
      aiLoading: false,
      finished: false,
      stats: { new: 0, rev: 0, again: 0, ok: 0, scoreSum: 0, scoreCount: 0 }
    };
    sessionEl.classList.add('open');
    nextCard();
  }
  function startSession() {
    startQueue(buildSRSQueue(), 'srs');
  }
  function startRandom() {
    startQueue(shuffle(ITEMS).slice(0, 10).map(x => ({ id: x.id, isNew: isNew(x.id) })), 'random');
  }
  function startWrong() {
    const ids = Object.keys(state.wrong)
      .filter(id => state.wrong[id]?.count > 0 && BY_ID[id])
      .sort((a, b) => (state.wrong[b].count || 0) - (state.wrong[a].count || 0))
      .slice(0, 10);
    if (!ids.length) { toast('还没有错题，先做一组今日默写吧'); return; }
    startQueue(ids.map(id => ({ id, isNew: isNew(id) })), 'wrong');
  }
  function startWeak(key) {
    const ids = ITEMS.filter(x => x.keyPoints.some(k => k.t === key) || x.a.includes(key))
      .slice(0, 6).map(x => x.id);
    if (!ids.length) { toast('没有找到相关条目'); return; }
    startQueue(ids.map(id => ({ id, isNew: isNew(id) })), 'weak');
  }
  function startOne(id) {
    closeSheet();
    startQueue([{ id, isNew: isNew(id) }], 'one');
  }

  function nextCard() {
    if (!session) return;
    if (!session.queue.length) {
      if (session.replay.length) {
        const r = session.replay.shift();
        session.current = { id: r.id, replay: true };
        session.submitted = false;
        session.result = null;
        session.ai = '';
        session.aiError = '';
        session.userAnswer = '';
        session.cardStart = Date.now();
        renderStudy();
        sessionEl.scrollTop = 0;
        return;
      }
      finishSession();
      return;
    }
    const c = session.queue.shift();
    session.current = c;
    session.userAnswer = state.drafts[c.id] || '';
    session.submitted = false;
    session.result = null;
    session.suggested = null;
    session.ai = '';
    session.aiError = '';
    session.aiLoading = false;
    session.cardStart = Date.now();
    renderStudy();
    sessionEl.scrollTop = 0;
  }

  function closeSession(goHome = false) {
    if (!session) return;
    const dirty = session.done > 0 || (session.userAnswer || '').trim() || session.submitted;
    if (!session.finished && dirty && !confirm('退出本次默写？已完成的进度会保存。')) return;
    window.speechSynthesis?.cancel();
    speechToken++;
    save();
    sessionEl.classList.remove('open');
    sessionEl.innerHTML = '';
    session = null;
    if (goHome) currentTab = 'home';
    render();
  }

  function submitAnswer(skipped = false) {
    if (!session || !session.current || session.current.replay || session.submitted) return;
    const item = BY_ID[session.current.id];
    if (!skipped && !(session.userAnswer || '').trim()) {
      toast('先写点内容，或者点“不会，看答案”');
      return;
    }
    const result = analyze(item, skipped ? '' : session.userAnswer);
    session.result = result;
    session.submitted = true;
    session.suggested = skipped ? 1 : scoreToRating(result.score);
    delete state.drafts[item.id];
    recordAttempt(item, result, skipped);
    if (state.settings.ai.key && state.settings.ai.auto) {
      setTimeout(runAI, 50);
    }
    save();
    renderStudy();
    sessionEl.scrollTop = 0;
  }

  function recordAttempt(item, res, skipped) {
    state.attempts.unshift({
      id: item.id,
      score: res.score,
      at: Date.now(),
      missing: res.missing.map(k => k.t).slice(0, 5),
      skipped: !!skipped
    });
    state.attempts = state.attempts.slice(0, 40);
    res.keys.forEach(k => {
      if (!state.weak[k.t]) state.weak[k.t] = { hit: 0, miss: 0, last: 0 };
      if (k.hit) state.weak[k.t].hit++;
      else state.weak[k.t].miss++;
      state.weak[k.t].last = Date.now();
    });
  }

  function finishCard(rating) {
    if (!session || !session.current || !session.submitted) return;
    const id = session.current.id;
    const item = BY_ID[id];
    const res = session.result;
    const stored = state.cards[id];
    const wasNew = isNew(id);
    const base = stored ? cardObj(id) : window.FSRS.createEmptyCard(new Date());
    let next;
    try {
      next = engine.next(base, new Date(), rating).card;
    } catch (e) {
      toast('复习计划计算出错，已按“记得”处理');
      next = engine.next(base, new Date(), 3).card;
    }
    state.cards[id] = {
      ...serializeCard(next),
      first: stored?.first || new Date().toISOString(),
      seen: (stored?.seen || 0) + 1,
      lastRating: rating
    };
    const day = getDay();
    if (wasNew) day.new++; else day.rev++;
    day.total++;
    day.scoreSum += res.score;
    day.scoreCount++;
    day.skipped += session.result && session.userAnswer.trim() === '' ? 1 : 0;
    if (rating === 1) day.again++; else day.ok++;
    day.ms += Date.now() - session.cardStart;

    if (!state.wrong[id]) state.wrong[id] = { count: 0, last: 0 };
    if (rating === 1) state.wrong[id].count++;
    else state.wrong[id].count = Math.max(0, state.wrong[id].count - 1);
    state.wrong[id].last = Date.now();

    session.stats.new += wasNew ? 1 : 0;
    session.stats.rev += wasNew ? 0 : 1;
    session.stats.again += rating === 1 ? 1 : 0;
    session.stats.ok += rating >= 3 ? 1 : 0;
    session.stats.scoreSum += res.score;
    session.stats.scoreCount++;
    session.done++;
    if (rating === 1) session.replay.push({ id });
    session.current = null;
    save();
    nextCard();
  }

  function finishSession() {
    session.finished = true;
    save();
    renderStudy();
    confetti();
  }

  /* --------------------------------------------------------------- study UI */
  function renderStudy() {
    if (!session) return;
    if (session.finished) { renderSummary(); return; }
    if (!session.current) { finishSession(); return; }
    const item = BY_ID[session.current.id];
    const done = session.done;
    const total = Math.max(session.total, done + session.queue.length + session.replay.length);
    const pct = total ? (done / total) * 100 : 0;
    const isReplay = !!session.current.replay;
    const title = session.mode === 'srs' ? '今日默写' : session.mode === 'random' ? '随机抽背' : session.mode === 'wrong' ? '错题重默' : session.mode === 'weak' ? '薄弱专项' : '单条默写';
    sessionEl.innerHTML = `<div class="session-shell">
      <div class="session-top">
        <button class="session-close" data-action="close-session" aria-label="退出">${ico('x')}</button>
        <div class="progress-track"><i style="width:${clamp(pct, 0, 100)}%"></i></div>
        <span class="session-counter">${isReplay ? '巩固' : `${Math.min(done + 1, total)}/${total}`}</span>
      </div>
      <div class="session-body">
        <div class="session-inner">
          <div class="study-eyebrow">
            <span class="pill">${esc(title)}</span>
            <span>第 ${item.n} 条 · ${esc(item.sec)}</span>
            ${isReplay ? '<span class="pill gold">再巩固</span>' : (session.current.isNew ? '<span class="pill gold">新学</span>' : '<span class="pill red">复习</span>')}
          </div>
          <div class="study-q">${esc(item.q)}</div>
          ${isReplay ? replayView(item) : (session.submitted ? resultView(item) : inputView(item))}
        </div>
      </div>
    </div>`;
    const ta = $('#answerInput');
    if (ta) {
      autoGrow(ta);
      ta.addEventListener('input', () => {
        session.userAnswer = ta.value;
        state.drafts[item.id] = ta.value;
        const cc = $('#charCount');
        if (cc) cc.textContent = `${ta.value.length} 字`;
        autoGrow(ta);
        clearTimeout(aiSaveTimer);
        aiSaveTimer = setTimeout(save, 500);
      });
      ta.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submitAnswer(false); }
      });
    }
  }
  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${clamp(el.scrollHeight, 150, 360)}px`;
  }
  function inputView(item) {
    const kp = item.keyPoints.length;
    return `
      <div class="study-meta">
        <span>${item.a.length} 字</span><span class="dot"></span><span>${kp} 个关键点</span>
        ${session.current.isNew ? '<span class="dot"></span><span>先按自己的理解写</span>' : ''}
      </div>
      <textarea id="answerInput" class="answer-input" placeholder="凭记忆写下答案。不必逐字一致，关键点要对。">${esc(session.userAnswer)}</textarea>
      <div class="answer-tools">
        <span id="charCount">${session.userAnswer.length} 字</span>
        <button class="btn btn-sm" data-action="speak-question">${ico('speaker')}朗读题目</button>
      </div>
      <div class="submit-row">
        <button class="btn btn-primary btn-block" data-action="submit-answer">${ico('check')}提交批改</button>
        <button class="btn btn-ghost" data-action="skip-answer">不会，看答案</button>
      </div>
      <div class="input-tip">提示：写不出来就点“不会”，先看结构和关键词，再默一遍。</div>`;
  }
  function replayView(item) {
    return `
      <div class="replay-note">刚才这条评了“忘记”，现在再记一遍结构和关键词，不用再评级。</div>
      <div class="answer-block">
        <div class="answer-label">参考答案</div>
        <div class="answer-text">${segHTML(item)}</div>
        <div class="key-row">${item.keyPoints.map(k => `<span>${esc(k.t)}</span>`).join('')}</div>
      </div>
      <button class="continue-btn" data-action="replay-continue">记住了，继续</button>`;
  }
  function resultView(item) {
    const res = session.result;
    const suggested = session.suggested || scoreToRating(res.score);
    const pv = previewFor(item.id);
    const ratings = [
      [1, '忘记', 'rate-again'],
      [2, '模糊', 'rate-hard'],
      [3, '记得', 'rate-good'],
      [4, '太简单', 'rate-easy']
    ];
    const interval = r => {
      try {
        const c = pv?.[r]?.card;
        return c ? fmtInterval(c.scheduled_days) : '—';
      } catch (e) { return '—'; }
    };
    const keyChips = res.keys.map(k => {
      const cls = k.hit ? 'hit' : (k.ratio >= 0.45 ? 'part' : 'miss');
      const label = k.hit ? '✓' : (k.ratio >= 0.45 ? '~' : '✗');
      return `<span class="kp ${cls}">${label} ${esc(k.t)}</span>`;
    }).join('');
    const missingTxt = res.missing.length
      ? `漏写/未命中 ${res.missing.length} / ${res.keys.length} 个要点`
      : '要点全部命中';
    const numTxt = res.numbers.missing.length || res.numbers.wrong.length
      ? `<div class="num-warn">数字：${res.numbers.missing.length ? '漏 ' + esc(res.numbers.missing.join('、')) : ''}${res.numbers.missing.length && res.numbers.wrong.length ? '；' : ''}${res.numbers.wrong.length ? '多/错 ' + esc(res.numbers.wrong.join('、')) : ''}</div>`
      : '';
    return `
      <div class="result-head">
        <div class="score-badge ${scoreClass(res.score)}" style="--p:${res.score}">
          <b>${res.score}</b><span>得分</span>
        </div>
        <div class="result-summary">
          <b>${missingTxt}</b>
          <p>${res.score >= 90 ? '很接近原文，注意个别措辞。' : res.score >= 70 ? '骨架对了，补一下漏掉的要点。' : res.score >= 40 ? '记住了一部分，先抓关键词再连成句。' : '这次没想起来，先看结构，再默一遍。'}</p>
          ${numTxt}
        </div>
      </div>
      <div class="key-hits">${keyChips}</div>
      <div class="compare-card">
        <div class="compare-label">参考答案 <span>红色 = 与原文不一致</span></div>
        <div class="answer-text">${res.refHTML}</div>
      </div>
      ${res.userHTML ? `<details class="extra-box"><summary>看看我写的内容（红色 = 多写/表述不同）</summary><div class="answer-text">${res.userHTML}</div></details>` : ''}
      <div class="advice-card">
        <div class="advice-title">${ico('bulb')}怎么记</div>
        <ul>${res.advice.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>
      <div class="ai-box" id="aiBox">${aiBoxHTML()}</div>
      <div class="rate-wrap">
        <div class="rate-hint">按这次默写，建议选「${ratings.find(r => r[0] === suggested)?.[1]}」。也可以自己调整。</div>
        <div class="rate-grid">
          ${ratings.map(([r, label, cls]) => `<button class="rate ${cls} ${r === suggested ? 'suggested' : ''}" data-action="rate" data-rating="${r}">
            <span>${label}</span><small>${interval(r)}</small>${r === suggested ? '<i>建议</i>' : ''}
          </button>`).join('')}
        </div>
        <div class="rate-foot">评级会决定下次复习时间，选完自动进入下一题。</div>
      </div>`;
  }
  function aiBoxHTML() {
    if (session.aiLoading) {
      return `<div class="ai-head"><span>AI 深度点评</span><span class="ai-status">分析中…</span></div><div class="ai-loading"><i></i><i></i><i></i></div>`;
    }
    if (session.ai) {
      return `<div class="ai-head"><span>AI 深度点评</span><button class="mini-link" data-action="ai-run">重新点评</button></div><div class="ai-text">${esc(session.ai).replace(/\n/g, '<br>')}</div>`;
    }
    if (session.aiError) {
      return `<div class="ai-head"><span>AI 深度点评</span><button class="mini-link" data-action="ai-run">重试</button></div><div class="ai-error">${esc(session.aiError)}</div>`;
    }
    if (!state.settings.ai.key) {
      return `<div class="ai-row"><div><b>想更细的点评？</b><span>配置 API Key 后，可让 AI 分析你的表述并给记忆建议。</span></div><button class="btn btn-sm" data-action="ai-settings">去配置</button></div>`;
    }
    return `<div class="ai-row"><div><b>AI 深度点评</b><span>把这道题发给已配置的模型，做更细的批改。</span></div><button class="btn btn-sm" data-action="ai-run">开始点评</button></div>`;
  }
  function renderSummary() {
    const s = session;
    const total = s.stats.scoreCount;
    const avg = total ? Math.round(s.stats.scoreSum / total) : 0;
    const remain = dueItems().length;
    const title = s.mode === 'srs' ? '本轮默写完成' : s.mode === 'random' ? '随机抽背完成' : s.mode === 'wrong' ? '错题重默完成' : s.mode === 'weak' ? '薄弱专项完成' : '默写完成';
    sessionEl.innerHTML = `<div class="session-shell">
      <div class="session-top"><button class="session-close" data-action="close-session">${ico('x')}</button><div class="progress-track"><i style="width:100%"></i></div><span class="session-counter">完成</span></div>
      <div class="session-body">
        <div class="summary">
          <div class="summary-badge">${ico('trophy')}</div>
          <h2>${title}</h2>
          <p>${s.done} 条 · 用时 ${fmtDuration(Date.now() - s.start)}</p>
          <div class="summary-grid">
            <div><b>${avg || '—'}</b><span>平均得分</span></div>
            <div><b>${s.stats.ok}/${s.done}</b><span>记得/简单</span></div>
            <div><b>${s.stats.again}</b><span>评了忘记</span></div>
          </div>
          <div class="summary-actions">
            ${remain ? `<button class="btn btn-primary btn-block" data-action="start-session">还有 ${remain} 条到期，继续</button>` : ''}
            <button class="btn btn-block" data-action="practice-random">随机抽背 10 题</button>
            <button class="btn btn-ghost btn-block" data-action="close-home">返回首页</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ------------------------------------------------------------------- AI */
  function aiEndpoint() {
    let base = (state.settings.ai.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('请先填写 Base URL');
    if (!/\/chat\/completions$/.test(base)) base += '/chat/completions';
    return base;
  }
  async function callAI(item, userAnswer, res) {
    const cfg = state.settings.ai;
    if (!cfg.key.trim()) throw new Error('请先填写 API Key');
    const base = aiEndpoint();
    const prompt = `你是一位理论学习背诵教练。请只依据下面的标准答案批改，不要补充标准答案之外的知识。
题目：${item.q}
标准答案：${item.a}
学生默写：${userAnswer.trim() || '（未作答）'}
本地检测：得分 ${res.score}；漏写要点：${res.missing.map(k => k.t).join('、') || '无'}；数字问题：${[...res.numbers.missing, ...res.numbers.wrong].join('、') || '无'}。
请按以下结构用中文回答，总字数不超过 350 字：
1. 批改：指出漏写、写错、表述不准的地方，尽量引用学生原话。
2. 记忆建议：给结构拆分、关键词或首字口诀、下次注意的 2-3 点。
3. 鼓励：一句话。`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    let resp;
    try {
      resp = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.key.trim()}`
        },
        body: JSON.stringify({
          model: cfg.model.trim(),
          messages: [
            { role: 'system', content: '你是严谨、简洁的中文背诵教练，只依据给定标准答案批改。' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3,
          max_tokens: 700
        }),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('接口超时，请稍后重试');
      throw new Error('网络请求失败：可能是接口不支持浏览器直连（CORS），或网络不通');
    }
    clearTimeout(timer);
    if (!resp.ok) {
      if (resp.status === 401) throw new Error('API Key 无效或已过期（401）');
      if (resp.status === 402) throw new Error('接口账户余额不足（402），请充值或换一个 Key');
      if (resp.status === 403) throw new Error('接口拒绝访问（403），请检查 Key 权限或地区限制');
      if (resp.status === 429) throw new Error('请求太频繁（429），稍后再试');
      const t = await resp.text().catch(() => '');
      throw new Error(`接口 ${resp.status}：${t.slice(0, 180)}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
    if (!content) throw new Error('接口没有返回文本内容');
    return String(content).trim();
  }
  async function runAI() {
    if (!session || !session.submitted || session.current?.replay || session.aiLoading) return;
    const cfg = state.settings.ai;
    if (!cfg.key.trim()) { openAiSettings(); toast('先配置 API Key'); return; }
    const item = BY_ID[session.current.id];
    const s = session;
    s.aiLoading = true;
    s.aiError = '';
    renderStudy();
    try {
      const text = await callAI(item, s.userAnswer, s.result);
      if (session === s) s.ai = text;
    } catch (e) {
      if (session === s) s.aiError = e.message || String(e);
    } finally {
      if (session === s) { s.aiLoading = false; renderStudy(); }
    }
  }
  async function testAI() {
    const cfg = state.settings.ai;
    if (!cfg.key.trim()) { toast('先填写 API Key'); return; }
    toast('正在测试连接…');
    try {
      const text = await callAI(
        { q: '测试', a: '连接成功', keyPoints: [], list: [] },
        '连接成功',
        { score: 100, missing: [], numbers: { missing: [], wrong: [] } }
      );
      toast(text ? '连接成功' : '接口有响应，但没有返回文本');
    } catch (e) {
      toast(e.message || '连接失败');
    }
  }

  /* ------------------------------------------------------------------ sheet */
  function openSettings() { openSheet(settingsHTML()); }
  function openAiSettings() { openSheet(aiSettingsHTML()); }
  function openAbout() { openSheet(aboutHTML()); }

  /* -------------------------------------------------------------- actions */
  function exportBackup() {
    const copy = JSON.parse(JSON.stringify(state));
    copy.settings.ai.key = '';
    const blob = new Blob([JSON.stringify(copy, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `理论记忆-备份-${todayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('备份已导出（不含 API Key）');
  }
  function importBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const d = JSON.parse(reader.result);
          if (!d || typeof d !== 'object' || !d.cards) throw new Error('bad');
          if (!confirm('导入会覆盖当前学习进度，确定吗？')) return;
          const keepKey = state.settings.ai.key;
          state = loadStateFrom(d);
          if (keepKey) state.settings.ai.key = keepKey;
          engine = makeEngine();
          save();
          render();
          closeSheet();
          toast('已导入备份');
        } catch (e) {
          toast('文件格式不正确');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }
  function loadStateFrom(d) {
    const base = blankState();
    return {
      ...base,
      ...d,
      cards: d.cards || {},
      days: d.days || {},
      drafts: d.drafts || {},
      attempts: Array.isArray(d.attempts) ? d.attempts : [],
      weak: d.weak || {},
      wrong: d.wrong || {},
      settings: {
        ...base.settings,
        ...(d.settings || {}),
        ai: { ...base.settings.ai, ...((d.settings || {}).ai || {}) }
      }
    };
  }
  function resetAll() {
    if (!confirm('确定清空全部学习进度？此操作不可恢复。')) return;
    if (!confirm('再确认一次：所有复习记录、错题和统计都会删除。')) return;
    const key = state.settings.ai.key;
    state = blankState();
    state.settings.ai.key = key;
    engine = makeEngine();
    save();
    render();
    closeSheet();
    toast('已清空');
  }
  function confetti() {
    confettiEl.innerHTML = '';
    const colors = ['#9c1c24', '#b08a4a', '#2f7d5d', '#2e6089', '#e6c78e'];
    for (let i = 0; i < 36; i++) {
      const s = document.createElement('i');
      s.style.left = `${Math.random() * 100}%`;
      s.style.background = colors[i % colors.length];
      s.style.setProperty('--t', `${1.2 + Math.random() * 1.2}s`);
      s.style.setProperty('--x', `${Math.random() * 160 - 80}px`);
      s.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
      s.style.animationDelay = `${Math.random() * 0.3}s`;
      confettiEl.appendChild(s);
    }
    setTimeout(() => { confettiEl.innerHTML = ''; }, 2800);
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) { toast('当前浏览器不支持朗读'); return; }
    window.speechSynthesis.cancel();
    const token = ++speechToken;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = clamp(Number(state.settings.ttsRate) || 0.95, 0.6, 1.4);
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find(x => /zh|Chinese|中文/i.test(`${x.lang} ${x.name}`));
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
    return token;
  }

  /* ------------------------------------------------------------- delegation */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const id = el.dataset.id;
    switch (action) {
      case 'tab':
        currentTab = el.dataset.tab;
        render();
        break;
      case 'start-session':
        closeSheet();
        startSession();
        break;
      case 'practice-random':
        closeSheet();
        startRandom();
        break;
      case 'practice-wrong':
        closeSheet();
        startWrong();
        break;
      case 'weak-start':
        closeSheet();
        startWeak(decodeURIComponent(el.dataset.key || ''));
        break;
      case 'study-one':
        startOne(id);
        break;
      case 'open-detail':
        openDetail(id);
        break;
      case 'close-sheet':
        closeSheet();
        break;
      case 'close-session':
        closeSession();
        break;
      case 'close-home':
        closeSession(true);
        break;
      case 'submit-answer':
        submitAnswer(false);
        break;
      case 'skip-answer':
        submitAnswer(true);
        break;
      case 'rate':
        finishCard(Number(el.dataset.rating));
        break;
      case 'replay-continue':
        session.current = null;
        nextCard();
        break;
      case 'speak-question':
        if (session?.current) {
          const item = BY_ID[session.current.id];
          speak(`${item.q}${session.submitted ? '。答案：' + item.a : ''}`);
        }
        break;
      case 'speak-detail':
        if (id && BY_ID[id]) speak(`${BY_ID[id].q}。${BY_ID[id].a}`);
        break;
      case 'ai-run':
        runAI();
        break;
      case 'ai-settings':
        openAiSettings();
        break;
      case 'ai-preset': {
        saveAISettings();
        const p = AI_PRESETS[el.dataset.preset];
        if (!p) break;
        state.settings.ai.preset = el.dataset.preset;
        if (p.baseUrl) state.settings.ai.baseUrl = p.baseUrl;
        if (p.model) state.settings.ai.model = p.model;
        save();
        openAiSettings();
        break;
      }
      case 'toggle-key': {
        const input = $('#aiKey');
        if (!input) break;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        el.textContent = show ? '隐藏' : '显示';
        break;
      }
      case 'ai-test':
        saveAISettings();
        testAI();
        break;
      case 'ai-done':
        saveAISettings();
        closeSheet();
        break;
      case 'ai-clear':
        if (!confirm('清除本机保存的 API Key？')) break;
        state.settings.ai.key = '';
        save();
        openAiSettings();
        toast('已清除');
        break;
      case 'settings-open':
        openSettings();
        break;
      case 'about-open':
        openAbout();
        break;
      case 'new-limit': {
        const d = Number(el.dataset.delta) || 0;
        state.settings.newLimit = clamp((state.settings.newLimit || 20) + d, 5, 50);
        save();
        openSettings();
        render();
        break;
      }
      case 'retention':
        state.settings.retention = Number(el.dataset.v) || 0.9;
        engine = makeEngine();
        save();
        openSettings();
        break;
      case 'max-interval':
        state.settings.maxInterval = Number(el.dataset.v) || 60;
        engine = makeEngine();
        save();
        openSettings();
        break;
      case 'theme':
        state.settings.theme = el.dataset.v || 'auto';
        applyTheme();
        save();
        openSettings();
        break;
      case 'export':
        exportBackup();
        break;
      case 'import':
        importBackup();
        break;
      case 'reset':
        resetAll();
        break;
      case 'install':
        installPWA();
        break;
      case 'lib-filter':
        libFilter = el.dataset.filter || 'all';
        $$('.filter').forEach(b => b.classList.toggle('active', b.dataset.filter === libFilter));
        $('#libListWrap').innerHTML = libListHTML();
        refreshLibCount();
        break;
      default:
        break;
    }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'libSearch') return; // handled in render
    if (['aiBase', 'aiModel', 'aiKey'].includes(e.target.id)) {
      clearTimeout(aiSaveTimer);
      aiSaveTimer = setTimeout(saveAISettings, 350);
    }
    if (e.target.id === 'aiAuto') {
      state.settings.ai.auto = e.target.checked;
      save();
    }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'aiAuto') {
      state.settings.ai.auto = e.target.checked;
      save();
    }
  });
  function saveAISettings() {
    const base = $('#aiBase'), model = $('#aiModel'), key = $('#aiKey');
    if (base) state.settings.ai.baseUrl = base.value.trim();
    if (model) state.settings.ai.model = model.value.trim();
    if (key) state.settings.ai.key = key.value.trim();
    save();
  }

  /* ---------------------------------------------------------------- install */
  function installPWA() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(() => { deferredPrompt = null; });
      return;
    }
    const ua = navigator.userAgent;
    if (/iphone|ipad|ipod/i.test(ua)) {
      alert('iPhone / iPad：用 Safari 打开本页 → 点底部“分享” → “添加到主屏幕”。');
    } else if (/android/i.test(ua)) {
      alert('Android：用 Chrome 打开本页 → 右上角菜单 → “添加到主屏幕”或“安装应用”。');
    } else {
      alert('在手机浏览器菜单里选择“添加到主屏幕”即可。电脑上可点地址栏右侧的安装图标。');
    }
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
  });
  window.addEventListener('online', () => toast('已恢复联网'));
  window.addEventListener('offline', () => toast('当前离线，默写和本地批改仍可用'));

  /* ---------------------------------------------------------------- startup */
  engine = makeEngine();
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (state.settings.theme === 'auto') applyTheme();
  });
  render();

  // expose a tiny debug/export hook for local testing
  window.__theory = { state, analyze, save, render, startSession, ITEMS };
})();
