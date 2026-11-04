// ==UserScript==
// @name         英语随读
// @namespace    en-overlay.yihuang
// @version      1.0
// @description  滚动时把英文段落就地翻译成中文，附带长句/俚语/短语注释，点词查义（Kimi API）
// @match        *://x.com/*
// @match        *://twitter.com/*
// @match        *://*.reddit.com/*
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      api.moonshot.cn
// ==/UserScript==
(function () {
  'use strict';
  if (window.__EO_LOADED) return; window.__EO_LOADED = true;
  const API = 'https://api.moonshot.cn/v1/chat/completions';
  const MODEL = 'kimi-k2.6';
  const host = location.hostname;
  const SITE = /(^|\.)(x|twitter)\.com$/.test(host) ? 'x' : /^old\.reddit\.com$/.test(host) ? 'oldreddit' : /(^|\.)reddit\.com$/.test(host) ? 'reddit' : 'generic';
  const SELECTORS = {
    x: ['article [data-testid="tweetText"]'],
    reddit: ['shreddit-post [slot="title"]', 'h1[slot="title"]', '[slot="text-body"] p', 'div[id$="-post-rtjson-content"] p', 'shreddit-comment [slot="comment"] p'],
    oldreddit: ['.usertext-body .md p', 'a.title'],
    generic: ['p'],
  };
  const MAX_BATCH_CHARS = 1500, MAX_BATCH_ITEMS = 6;
  const stats = window.__eoStats = { start: Date.now(), requests: 0, done: 0, firstAt: 0, errors: 0, log: [] };
  const log = (...a) => { const s = '[EO] ' + a.join(' '); stats.log.push(((Date.now() - stats.start) / 1000).toFixed(1) + 's ' + s); console.log(s); };

  // ---------- storage ----------
  const hasGMs = typeof GM_getValue === 'function';
  const hasGMa = typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function';
  async function getVal(k, d) {
    try { if (hasGMs) { const v = GM_getValue(k); if (v !== undefined) return v; } else if (hasGMa) { const v = await GM.getValue(k); if (v !== undefined) return v; } } catch (e) {}
    const v = localStorage.getItem('eo_' + k); return v === null ? d : JSON.parse(v);
  }
  async function setVal(k, v) {
    try { if (hasGMs) GM_setValue(k, v); else if (hasGMa) await GM.setValue(k, v); } catch (e) {}
    try { localStorage.setItem('eo_' + k, JSON.stringify(v)); } catch (e) {}
  }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + s.length.toString(36); }
  const CK = 'eoc1_';
  function cacheGet(t) { try { const v = localStorage.getItem(CK + hash(t)); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function cacheSet(t, v) {
    const k = CK + hash(t), s = JSON.stringify(v);
    try { localStorage.setItem(k, s); } catch (e) { // quota: drop oldest half of our entries
      try { const ks = Object.keys(localStorage).filter(x => x.startsWith(CK)); ks.slice(0, Math.ceil(ks.length / 2)).forEach(x => localStorage.removeItem(x)); localStorage.setItem(k, s); } catch (e2) {}
    }
  }

  // ---------- http ----------
  function http(body, key) {
    const gmx = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
    if (gmx) return new Promise((res, rej) => {
      gmx({ method: 'POST', url: API, headers, data: JSON.stringify(body), timeout: 120000,
        onload: r => res({ status: r.status, text: r.responseText }), onerror: e => rej(new Error('network')), ontimeout: () => rej(new Error('timeout')) });
    });
    return fetch(API, { method: 'POST', headers, body: JSON.stringify(body) }).then(async r => ({ status: r.status, text: await r.text() }));
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const starts = []; // sliding window: max 3 request starts per 61s
  async function callLLM(messages) {
    for (let attempt = 0; attempt <= 5; attempt++) {
      while (starts.length >= 3 && Date.now() - starts[0] < 61000) await sleep(61000 - (Date.now() - starts[0]) + 50);
      while (starts.length >= 3 && Date.now() - starts[0] >= 61000) starts.shift();
      starts.push(Date.now()); if (starts.length > 3) starts.shift();
      stats.requests++;
      let r;
      try { r = await http({ model: MODEL, messages, thinking: { type: 'disabled' } }, state.key); }
      catch (e) { log('net error', e.message); await sleep(20000); continue; }
      if (r.status === 200) { const j = JSON.parse(r.text); return j.choices[0].message.content; }
      if (r.status === 429) { const m = /after\s+(\d+(?:\.\d+)?)\s*s/i.exec(r.text); const w = m ? parseFloat(m[1]) * 1000 + 500 : 20000; log('429, wait', w); await sleep(w); continue; }
      if (r.status === 401) { state.lastError = 'API Key 无效 (401)'; updatePanel(); throw new Error('401'); }
      log('http', r.status, r.text.slice(0, 200)); state.lastError = 'HTTP ' + r.status; await sleep(20000);
    }
    throw new Error('retries exhausted');
  }
  function parseJSON(s) {
    s = String(s).replace(/```(?:json)?/gi, '').trim();
    const a = s.search(/[\[{]/), b = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) { return JSON.parse(s.replace(/,\s*([\]}])/g, '$1')); }
  }

  // ---------- prompts ----------
  const SYS = `你是英语阅读助手，读者是中文母语的中级英语学习者。对每个英文段落：给出自然流畅的简体中文翻译(zh)，并找出该段的难点：
long: 结构复杂的长难句，text为原句片段，note为中文结构解析(主干+从句，简短)；
slang: 俚语、网络用语、缩写、口语梗，text为原文，note为中文解释；
phrase: 值得学习的短语/固定搭配/习语，text为原文短语，zh为中文意思，example为一个简短英文例句。
没有就给空数组，每类最多4条，不要硬凑。只输出严格JSON，不要代码块，不要任何解释。格式：[{"id":"...","zh":"...","long":[{"text":"","note":""}],"slang":[{"text":"","note":""}],"phrase":[{"text":"","zh":"","example":""}]}]`;
  const WSYS = `你是英汉词典。根据单词及其所在句子，输出严格JSON(不要代码块)：{"word":"","ipa":"","pos":"","ctx":"该词在此句中的中文意思","defs":["词性. 中文释义",...最多4条],"phrases":["常见搭配 中文",...最多3条],"example":"英文例句 — 中文翻译","note":"用法/辨析/词源提示(可空)"}`;

  // ---------- state ----------
  const state = { key: '', paused: false, lookup: true, lastError: '', wordQ: [], running: false };
  const items = new Map(); // el -> {text, status:'idle'|'pending'|'inflight'|'done', box}
  let uid = 0;

  // ---------- detection ----------
  const cjk = s => (s.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  const latin = s => (s.match(/[A-Za-z]/g) || []).length;
  function isEnglish(t, min) {
    if (t.length < min) return false;
    const L = latin(t), C = cjk(t); if (C > L * 0.15) return false;
    return L / t.replace(/\s/g, '').length > 0.55;
  }
  function genericEnabled() {
    const lang = (document.documentElement.lang || '').toLowerCase();
    if (lang.startsWith('en')) return true;
    if (lang && !lang.startsWith('en')) { /* still check text */ }
    const t = (document.body.innerText || '').slice(0, 4000);
    return isEnglish(t, 200);
  }
  function minLen() { return SITE === 'generic' ? 40 : 20; }

  // ---------- styles ----------
  function isDarkBg() {
    let el = document.body;
    for (const n of [document.body, document.documentElement]) {
      const c = getComputedStyle(n).backgroundColor; const m = c.match(/[\d.]+/g);
      if (m && !(m.length === 4 && +m[3] === 0)) { const [r, g, b] = m.map(Number); return (0.299 * r + 0.587 * g + 0.114 * b) < 128; }
    }
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function applyTheme() { document.documentElement.classList.toggle('eo-dark', isDarkBg()); }
  const css = `
.eo-box{all:initial;display:block;box-sizing:border-box;margin:6px 0 10px;padding:6px 0 4px 10px;border-left:2px solid rgba(29,155,240,.55);font:15px/1.65 -apple-system,"PingFang SC","Noto Sans CJK SC","Hiragino Sans GB",sans-serif;color:inherit;color:#333;word-break:break-word;white-space:normal;text-align:left;text-indent:0}
.eo-dark .eo-box{color:#d6d9dc}
.eo-box.eo-wait{color:#999;font-size:12px;border-left-color:rgba(128,128,128,.35)}
.eo-zh{display:block}
.eo-tabs{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.eo-tab{all:unset;font:12px/1 -apple-system,"PingFang SC",sans-serif;padding:5px 9px;border-radius:999px;background:rgba(128,128,128,.13);color:#666;cursor:pointer;-webkit-tap-highlight-color:transparent}
.eo-dark .eo-tab{color:#aab}
.eo-tab.eo-on{background:rgba(29,155,240,.9);color:#fff}
.eo-tab.eo-empty{opacity:.4}
.eo-pane{display:none;margin-top:6px;padding:8px 10px;border-radius:8px;background:rgba(128,128,128,.09);font-size:13.5px;line-height:1.6}
.eo-pane.eo-open{display:block}
.eo-it{margin:0 0 7px}.eo-it:last-child{margin:0}
.eo-t{font-weight:600;color:#1d7fc4}.eo-dark .eo-t{color:#6cc3ff}
.eo-ex{display:block;opacity:.7;font-style:italic;font-size:12.5px}
.eo-err{color:#d33;font-size:12px}
#eo-fab{all:initial;position:fixed;right:10px;bottom:84px;z-index:2147483646;width:34px;height:34px;border-radius:17px;background:rgba(29,155,240,.85);color:#fff;font:600 14px/34px -apple-system,"PingFang SC",sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;-webkit-tap-highlight-color:transparent;opacity:.75}
#eo-fab.eo-paused{background:rgba(120,120,120,.85)}
#eo-fab .eo-badge{position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;border-radius:8px;background:#f4212e;font:600 10px/16px sans-serif;padding:0 3px;box-sizing:border-box}
#eo-panel{all:initial;position:fixed;left:50%;transform:translateX(-50%);bottom:130px;z-index:2147483647;width:min(340px,92vw);box-sizing:border-box;padding:14px;border-radius:14px;background:#fff;color:#222;font:14px/1.5 -apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3)}
.eo-dark #eo-panel,.eo-dark #eo-pop{background:#1e2329;color:#e6e6e6}
#eo-panel input[type=password],#eo-panel input[type=text]{width:100%;box-sizing:border-box;font-size:16px;padding:8px;border:1px solid #8886;border-radius:8px;background:transparent;color:inherit;margin:6px 0}
#eo-panel button{font:14px -apple-system,sans-serif;padding:7px 12px;border-radius:8px;border:0;background:#1d9bf0;color:#fff;margin:4px 6px 0 0}
#eo-panel button.eo-sec{background:rgba(128,128,128,.25);color:inherit}
#eo-panel label{display:block;margin:6px 0}
#eo-panel .eo-st{font-size:12px;opacity:.7;margin-top:8px}
#eo-pop{all:initial;position:fixed;z-index:2147483647;width:min(320px,90vw);max-height:50vh;overflow:auto;box-sizing:border-box;padding:12px 14px;border-radius:12px;background:#fff;color:#222;font:14px/1.55 -apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.3)}
#eo-pop .eo-w{font-size:18px;font-weight:700}#eo-pop .eo-ipa{opacity:.6;margin-left:6px;font-size:13px}
#eo-pop .eo-ctx{margin:6px 0;padding:6px 8px;border-radius:6px;background:rgba(29,155,240,.12)}
#eo-pop ul{margin:4px 0;padding-left:18px}#eo-pop .eo-sm{font-size:12.5px;opacity:.8;margin-top:4px}
.eo-hl{background:rgba(29,155,240,.25);border-radius:3px}
`;

  // ---------- UI ----------
  let fab, panel;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function mkFab() {
    fab = document.createElement('div'); fab.id = 'eo-fab'; fab.textContent = '译';
    fab.addEventListener('click', e => { e.stopPropagation(); togglePanel(); });
    document.body.appendChild(fab);
  }
  function pendingCount() { let n = 0; for (const it of items.values()) if (it.status === 'pending' || it.status === 'inflight') n++; return n; }
  function updatePanel() {
    if (fab) { fab.classList.toggle('eo-paused', state.paused); const n = pendingCount(); fab.innerHTML = (state.paused ? 'Ⅱ' : '译') + (n ? `<span class="eo-badge">${n}</span>` : ''); }
    if (panel) { const st = panel.querySelector('.eo-st'); if (st) st.textContent = `请求 ${stats.requests} · 已译 ${stats.done} · 排队 ${pendingCount()}${state.lastError ? ' · ' + state.lastError : ''}`; }
  }
  function togglePanel(force) {
    if (panel && !force) { panel.remove(); panel = null; return; }
    if (panel) panel.remove();
    panel = document.createElement('div'); panel.id = 'eo-panel';
    panel.innerHTML = `<b>英语随读</b>
      <div style="font-size:12px;opacity:.7">Kimi API Key（只保存在本机）</div>
      <input type="password" placeholder="sk-..." autocomplete="off" value="${esc(state.key)}">
      <label><input type="checkbox" class="eo-lk" ${state.lookup ? 'checked' : ''}> 点按单词查释义</label>
      <button class="eo-save">保存</button><button class="eo-sec eo-pause">${state.paused ? '继续' : '暂停'}</button><button class="eo-sec eo-close">关闭</button>
      <div class="eo-st"></div>`;
    panel.addEventListener('click', e => e.stopPropagation());
    panel.querySelector('.eo-save').onclick = async () => { state.key = panel.querySelector('input[type=password]').value.trim(); state.lookup = panel.querySelector('.eo-lk').checked; await setVal('key', state.key); await setVal('lookup', state.lookup); state.lastError = ''; togglePanel(); kick(); };
    panel.querySelector('.eo-pause').onclick = async () => { state.paused = !state.paused; await setVal('paused', state.paused); togglePanel(); updatePanel(); kick(); };
    panel.querySelector('.eo-close').onclick = () => togglePanel();
    document.body.appendChild(panel); updatePanel();
  }

  // ---------- rendering ----------
  function anchorFor(el) { return (SITE === 'oldreddit' && el.matches('a.title')) ? (el.closest('p.title') || el) : el; }
  function ensureBox(it) {
    if (it.box && it.box.isConnected) return it.box;
    const b = document.createElement('div'); b.className = 'eo-box'; b.setAttribute('translate', 'no');
    b.addEventListener('click', e => e.stopPropagation(), false);
    const a = anchorFor(it.el); a.insertAdjacentElement('afterend', b); it.box = b; return b;
  }
  function render(it, r) {
    const b = ensureBox(it); b.className = 'eo-box';
    const cats = [['long', '长句'], ['slang', '俚语'], ['phrase', '短语']];
    const lists = cats.map(([k]) => Array.isArray(r[k]) ? r[k].filter(x => x && x.text) : []);
    let h = `<span class="eo-zh">${esc(r.zh)}</span>`;
    if (lists.some(l => l.length)) {
      h += '<div class="eo-tabs">' + cats.map(([k, n], i) => `<button class="eo-tab${lists[i].length ? '' : ' eo-empty'}" data-k="${k}">${n} ${lists[i].length}</button>`).join('') + '</div>';
      h += cats.map(([k], i) => `<div class="eo-pane" data-k="${k}">${lists[i].length ? lists[i].map(x => k === 'phrase'
        ? `<div class="eo-it"><span class="eo-t">${esc(x.text)}</span> ${esc(x.zh || x.note)}${x.example ? `<span class="eo-ex">${esc(x.example)}</span>` : ''}</div>`
        : `<div class="eo-it"><span class="eo-t">${esc(x.text)}</span><br>${esc(x.note || x.zh)}</div>`).join('') : '<div class="eo-it" style="opacity:.6">无</div>'}</div>`).join('');
    }
    b.innerHTML = h;
    b.querySelectorAll('.eo-tab').forEach(t => t.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const k = t.dataset.k, on = !t.classList.contains('eo-on');
      b.querySelectorAll('.eo-tab').forEach(x => x.classList.remove('eo-on')); b.querySelectorAll('.eo-pane').forEach(x => x.classList.remove('eo-open'));
      if (on) { t.classList.add('eo-on'); b.querySelector(`.eo-pane[data-k="${k}"]`).classList.add('eo-open'); }
    }));
  }
  function showWait(it, txt) { const b = ensureBox(it); if (!b.querySelector('.eo-zh')) { b.className = 'eo-box eo-wait'; b.textContent = txt; } }

  // ---------- scanning ----------
  const io = new IntersectionObserver(ents => {
    for (const e of ents) { const it = items.get(e.target); if (!it) continue; it.near = e.isIntersecting;
      if (it.near && it.status === 'idle') { const c = cacheGet(it.text); if (c) { it.status = 'done'; render(it, c); } else { it.status = 'pending'; showWait(it, '⋯ 排队翻译中'); } } }
    updatePanel(); kick();
  }, { rootMargin: '400px 0px 600px 0px' });
  function getText(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function scan() {
    const sels = SELECTORS[SITE];
    for (const el of document.querySelectorAll(sels.join(','))) {
      if (el.dataset.eo || el.closest('.eo-box,#eo-panel,#eo-pop')) continue;
      if (SITE === 'generic') { if (el.closest('nav,footer,header,aside,[role=navigation]')) continue; if (el.querySelector('p')) continue; }
      if (SITE === 'reddit' && el.matches('p') && el.parentElement && el.parentElement.closest('[slot="comment"] p,[slot="text-body"] p')) continue;
      const t = getText(el);
      if (!isEnglish(t, minLen())) { el.dataset.eo = 'skip'; continue; }
      el.dataset.eo = String(++uid);
      items.set(el, { el, text: t, id: el.dataset.eo, status: 'idle', near: false });
      io.observe(el);
    }
    // drop removed elements (X virtualises its timeline)
    for (const [el, it] of items) if (!el.isConnected) { io.unobserve(el); items.delete(el); }
  }
  let scanT; const mo = new MutationObserver(() => { clearTimeout(scanT); scanT = setTimeout(scan, 400); });

  // ---------- scheduler ----------
  function eligible() {
    const vh = innerHeight, out = [];
    for (const it of items.values()) {
      if (it.status !== 'pending' || !it.el.isConnected) continue;
      const r = it.el.getBoundingClientRect();
      if (r.bottom < -vh || r.top > vh * 2.5) continue; // too far: wait until scrolled back near
      const inView = r.bottom > 0 && r.top < vh;
      it._prio = inView ? r.top : (r.top >= vh ? 10000 + r.top - vh : 20000 - r.bottom);
      out.push(it);
    }
    return out.sort((a, b) => a._prio - b._prio);
  }
  function kick() { if (!state.running) loop(); }
  async function loop() {
    state.running = true;
    try {
      while (true) {
        if (state.wordQ.length && state.key) { const w = state.wordQ.shift(); await doWord(w); continue; }
        if (state.paused || !state.key) break;
        const el = eligible(); if (!el.length) break;
        const batch = []; let chars = 0;
        const maxC = stats.done ? MAX_BATCH_CHARS : 500, maxN = stats.done ? MAX_BATCH_ITEMS : 2; // small first batch = faster first paint
        for (const it of el) { if (batch.length && (chars + it.text.length > maxC || batch.length >= maxN)) break; batch.push(it); chars += it.text.length; }
        await doBatch(batch);
      }
    } finally { state.running = false; updatePanel(); }
  }
  async function doBatch(batch) {
    batch.forEach(it => { it.status = 'inflight'; showWait(it, '⋯ 翻译中'); }); updatePanel();
    const payload = batch.map(it => ({ id: it.id, text: it.text }));
    const t0 = Date.now();
    try {
      const out = await callLLM([{ role: 'system', content: SYS }, { role: 'user', content: '页面: ' + document.title.slice(0, 80) + '\n段落(JSON数组，按id返回同样个数的结果)：\n' + JSON.stringify(payload) }]);
      let arr = parseJSON(out); if (!Array.isArray(arr)) arr = arr.items || arr.results || arr.data || [arr];
      const byId = {}; arr.forEach((r, i) => { byId[String(r.id != null ? r.id : batch[i] && batch[i].id)] = r; });
      batch.forEach((it, i) => {
        const r = byId[it.id] || (arr.length === batch.length ? arr[i] : null);
        if (r && r.zh) { cacheSet(it.text, r); it.status = 'done'; stats.done++; if (!stats.firstAt) stats.firstAt = Date.now(); render(it, r); }
        else { it.status = 'pending'; showWait(it, '⋯ 排队翻译中'); }
      });
      log('batch', batch.length, 'items', payload.reduce((a, b) => a + b.text.length, 0), 'chars in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } catch (e) {
      stats.errors++; log('batch failed', e.message);
      batch.forEach(it => { it.status = e.message === '401' ? 'idle' : 'pending'; if (it.box) { it.box.className = 'eo-box'; it.box.innerHTML = '<span class="eo-err">翻译失败，稍后重试</span>'; } });
      if (e.message === '401') state.paused = true;
    }
    updatePanel();
  }

  // ---------- word lookup ----------
  let pop;
  function closePop() { if (pop) { pop.remove(); pop = null; } document.querySelectorAll('.eo-hl').forEach(s => { const p = s.parentNode; p.replaceChild(document.createTextNode(s.textContent), s); p.normalize(); }); }
  function wordAt(x, y) {
    let range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (!range && document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); } }
    if (!range || range.startContainer.nodeType !== 3) return null;
    const node = range.startContainer, s = node.data; let i = range.startOffset, a = i, b = i;
    const isW = c => /[A-Za-z'’-]/.test(c);
    while (a > 0 && isW(s[a - 1])) a--; while (b < s.length && isW(s[b])) b++;
    let w = s.slice(a, b).replace(/^['’-]+|['’-]+$/g, ''); if (!/[A-Za-z]{2,}/.test(w)) return null;
    a = s.indexOf(w, a); return { node, a, b: a + w.length, word: w };
  }
  function sentenceOf(text, word) {
    const parts = text.split(/(?<=[.!?。])\s+/); return (parts.find(p => p.includes(word)) || text).slice(0, 400);
  }
  function placePop(x, y) {
    const r = pop.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
    let left = Math.min(Math.max(8, x - r.width / 2), vw - r.width - 8);
    let top = y + 18; if (top + r.height > vh - 8) top = Math.max(8, y - r.height - 14);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  function onTap(e) {
    if (!state.lookup || e.target.closest('a,button,.eo-box,#eo-panel,#eo-pop,#eo-fab,input,textarea')) return;
    let host = null; for (const el of items.keys()) if (el.contains(e.target)) { host = el; break; }
    if (!host) { if (pop) closePop(); return; }
    const sel = getSelection(); if (sel && String(sel).trim().length > 1) return;
    const w = wordAt(e.clientX, e.clientY); if (!w) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    closePop();
    try { const r = document.createRange(); r.setStart(w.node, w.a); r.setEnd(w.node, w.b); const sp = document.createElement('span'); sp.className = 'eo-hl'; r.surroundContents(sp); } catch (er) {}
    const ctx = sentenceOf(items.get(host).text, w.word);
    pop = document.createElement('div'); pop.id = 'eo-pop'; pop.addEventListener('click', ev => ev.stopPropagation());
    pop.innerHTML = `<div class="eo-w">${esc(w.word)}</div><div class="eo-sm">⋯ 查询中${state.running ? '（排在当前翻译之后）' : ''}</div>`;
    document.body.appendChild(pop); placePop(e.clientX, e.clientY);
    const key = 'w:' + w.word.toLowerCase() + '|' + ctx; const c = cacheGet(key);
    const job = { word: w.word, ctx, key, pop, x: e.clientX, y: e.clientY };
    if (c) return renderWord(job, c);
    if (!state.key) { pop.querySelector('.eo-sm').textContent = '请先在「译」按钮里填写 API Key'; return; }
    state.wordQ.unshift(job); kick();
  }
  async function doWord(job) {
    try {
      const out = await callLLM([{ role: 'system', content: WSYS }, { role: 'user', content: JSON.stringify({ word: job.word, sentence: job.ctx }) }]);
      const r = parseJSON(out); cacheSet(job.key, r); renderWord(job, r);
    } catch (e) { if (job.pop.isConnected) job.pop.querySelector('.eo-sm').textContent = '查询失败：' + e.message; }
  }
  function renderWord(job, r) {
    if (!job.pop.isConnected) return;
    job.pop.innerHTML = `<div><span class="eo-w">${esc(r.word || job.word)}</span><span class="eo-ipa">${esc(r.ipa)} ${esc(r.pos)}</span></div>
      ${r.ctx ? `<div class="eo-ctx">此处：${esc(r.ctx)}</div>` : ''}
      ${(r.defs || []).length ? '<ul>' + r.defs.map(d => `<li>${esc(d)}</li>`).join('') + '</ul>' : ''}
      ${(r.phrases || []).length ? '<div class="eo-sm">搭配：' + r.phrases.map(esc).join('；') + '</div>' : ''}
      ${r.example ? `<div class="eo-sm"><i>${esc(r.example)}</i></div>` : ''}
      ${r.note ? `<div class="eo-sm">💡 ${esc(r.note)}</div>` : ''}`;
    placePop(job.x, job.y);
  }

  // ---------- init ----------
  async function init() {
    if (SITE === 'generic' && !genericEnabled()) return;
    if ((SITE === 'generic' || SITE === 'oldreddit') && !document.querySelector('meta[name="viewport"]')) { // old desktop-only book pages: make them phone-readable
      const m = document.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width, initial-scale=1'; document.head.appendChild(m);
      const f = document.createElement('style'); f.textContent = 'body{max-width:100%!important;margin:0 auto!important;padding:0 14px!important;box-sizing:border-box;overflow-wrap:break-word}img,table{max-width:100%!important;height:auto}' + (SITE === 'oldreddit' ? '.side{display:none!important}.content{margin:0!important}body{font-size:15px!important}.md{font-size:15px!important;max-width:none!important}' : ''); document.head.appendChild(f);
    }
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    applyTheme(); setInterval(applyTheme, 5000);
    state.key = await getVal('key', ''); state.paused = await getVal('paused', false); state.lookup = await getVal('lookup', true);
    mkFab();
    if (!state.key) togglePanel(true);
    document.addEventListener('click', onTap, true);
    document.addEventListener('click', e => { if (pop && !e.target.closest('#eo-pop')) closePop(); if (panel && !e.target.closest('#eo-panel,#eo-fab')) togglePanel(); });
    scan(); mo.observe(document.body, { childList: true, subtree: true });
    setInterval(updatePanel, 3000);
    log('init site=' + SITE);
  }
  init();
})();
