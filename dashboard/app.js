// Launch Radar dashboard (radar-10). Reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, the evidence, and
// a per-protocol detail view. No network: every byte it shows is in
// data.js. The fit runs in main.ts, never in this browser — this page
// only displays and re-checks what main.ts computed.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = {
    q: '', category: 'all', chain: 'all', verdict: 'all', tier: 'all',
    sort: 'rank', dir: 1, selected: null,
    dropShare: 7, horizon: 12, deposit: 500,
    pinned: {}
  };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  var usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtInt(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtSigned(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  }
  // Age in years once a protocol is a year old, in days before that.
  function formatAge(days) {
    if (days === null || days === undefined) return '—';
    if (days >= 365) return (days / 365.25).toFixed(1) + ' yr';
    return Math.max(0, Math.round(days)) + ' d';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // ---- Integrity, recomputed in the browser from the data file.
  function fnv1aHex(str) {
    var bytes = new TextEncoder().encode(str);
    var hash = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      hash = hash ^ bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }
  function integrityChecks() {
    var rows = DATA.rows;
    var sorted = rows.slice().sort(function (a, b) { return a.rank - b.rank; });
    var input = sorted.map(function (r) { return r.slug + '|' + r.rank + '|' + r.impliedValueUsd; }).join('\n');
    var total = 0;
    rows.forEach(function (r) { total += r.impliedValueUsd; });
    var covered = rows.filter(function (r) { return r.watchlist; }).length;
    var ranksOk = true;
    for (var i = 0; i < sorted.length; i++) if (sorted[i].rank !== i + 1) ranksOk = false;
    var decOk = true;
    for (var j = 1; j < sorted.length; j++) if (sorted[j].impliedValueUsd >= sorted[j - 1].impliedValueUsd) decOk = false;
    var ig = DATA.integrity || {};
    return [
      { label: 'checksum', pass: fnv1aHex(input) === ig.checksum },
      { label: 'total implied', pass: Math.abs(Math.round(total * 100) / 100 - ig.totalImplied) < 0.01 },
      { label: 'watchlist covered', pass: covered === ig.watchlistCovered && covered === ig.watchlistTotal },
      { label: 'ranks 1..N', pass: ranksOk },
      { label: 'implied decreasing', pass: decOk },
      { label: 'row count', pass: rows.length === ig.rows }
    ];
  }

  // ---- Filtering, sorting, pinning.
  function tierOf(r) {
    if (r.watchlist) return 'watchlist';
    if (r.tvlUsd < (DATA.floorUsd || 50000000)) return 'early';
    return 'offlist';
  }
  function isPinned(r) { return !!state.pinned[r.slug]; }
  function pinnedCount() {
    return Object.keys(state.pinned).filter(function (k) { return state.pinned[k]; }).length;
  }
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (isPinned(r)) return true; // pinned rows stay visible through every filter
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (state.tier !== 'all' && tierOf(r) !== state.tier) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    var dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvlUsd; bv = b.tvlUsd; }
      else if (key === 'odds') { av = a.tokenOdds; bv = b.tokenOdds; }
      else if (key === 'implied') { av = a.impliedValueUsd; bv = b.impliedValueUsd; }
      else if (key === 'age') { av = a.ageDays === null ? Infinity : a.ageDays; bv = b.ageDays === null ? Infinity : b.ageDays; }
      else { av = a.rank; bv = b.rank; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // ---- Sections.
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { text: 'Launch Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: DATA.rows.length + ' pre-token rows' }),
        el('span', { text: 'Model ' + DATA.model })
      )
    );
  }

  function lede() {
    var total = 0;
    DATA.rows.forEach(function (r) { total += r.impliedValueUsd; });
    return el('section', { class: 'lede' },
      el('h1', { text: DATA.rows.length + ' pre-token protocols, ranked by implied value — ' + fmtUsd(total) + ' in total' }),
      el('p', { text: 'Implied value is TVL × a fitted multiple × the chance a ticker is recorded for the protocol. The multiple and the odds are fitted from this snapshot’s own priced protocols — no name is special-cased, no figure is hand-picked. It is a model, not a promise.' })
    );
  }

  function statStrip() {
    var ev = DATA.evidence || {};
    var v = ev.value || {};
    var o = ev.odds || {};
    var rg = (ev.range || {}).rows || [];
    var r50 = rg[0] || {}, r80 = rg[1] || {};
    function pct(x) { return (x === undefined || x === null) ? '—' : Math.round(x * 100) + '%'; }
    function x2(x) { return (x === undefined || x === null) ? '—' : '×' + Number(x).toFixed(2); }
    var keptValue = (v.terms || []).filter(function (t) { return t.kept === 'kept'; });
    var keptOdds = (o.terms || []).filter(function (t) { return t.kept === 'kept'; });
    var counts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
    DATA.rows.forEach(function (r) { if (counts[r.verdict] !== undefined) counts[r.verdict]++; });
    var watch = DATA.rows.filter(function (r) { return r.watchlist; }).length;
    function card(label, value, sub) {
      return el('div', { class: 'card' },
        el('div', { class: 'label', text: label }),
        el('div', { class: 'value', text: value }),
        el('div', { class: 'sub', text: sub }));
    }
    return el('section', { class: 'strip', 'aria-label': 'Model summary' },
      card('Out-of-sample miss', x2(v.finalWf) + ' walk-forward', 'leave-one-out ' + x2(v.finalLoo) + ' · flat multiple ' + x2(v.baselineWf) + ' walk-forward'),
      card('Range honesty', 'P25–P75 ' + pct(r50.wf) + ' · P10–P90 ' + pct(r80.wf), 'stated 50% / 80% · leave-one-out ' + pct(r50.loo) + ' / ' + pct(r80.loo)),
      card('Token odds', 'Brier ' + (o.finalWfBrier === undefined ? '—' : Number(o.finalWfBrier).toFixed(3)) + ' walk-forward', 'ten-fold ' + (o.finalBrier === undefined ? '—' : Number(o.finalBrier).toFixed(3)) + ' · base rate ' + (o.baseRate === undefined ? '—' : Number(o.baseRate).toFixed(3)) + ' · n=' + (o.n === undefined ? '—' : o.n)),
      card('Terms that survived', keptValue.length + ' value terms · ' + keptOdds.length + ' odds groups', keptValue.map(function (t) { return t.name; }).concat(keptOdds.map(function (t) { return t.name; })).join(' · ') || '—'),
      card('Worth farming', counts.FARM + ' FARM of ' + DATA.rows.length, counts.MARGINAL + ' marginal · ' + counts.SKIP + ' skip — net beats a T-bill and $25/hour'),
      card('Watchlist', watch + ' of 40 ranked', 'plus ' + (DATA.rows.length - 40) + ' pre-token protocols below the floor')
    );
  }

  var ACCT_COLORS = ['#f2b544', '#5b9bd5', '#4caf7d', '#8e6fc0', '#d96a5f', '#e07b39', '#3fa7a0', '#c0a062', '#7d8aa0'];
  function accountingSection() {
    var acc = DATA.accounting;
    if (!acc) return el('section', { class: 'panel' }, el('h2', { text: 'Protocol accounting' }), el('p', { text: 'No ledger in this data file.' }));
    var bar = el('div', { class: 'acct-bar' });
    var legend = el('div', { class: 'legend' });
    acc.groups.forEach(function (g, i) {
      var color = ACCT_COLORS[i % ACCT_COLORS.length];
      var seg = el('i', { style: 'width:' + (acc.total ? (g.count / acc.total * 100) : 0) + '%;background:' + color, title: g.label + ': ' + g.count });
      bar.appendChild(seg);
      legend.appendChild(el('span', null,
        el('span', { class: 'sw', style: 'background:' + color }),
        document.createTextNode(g.count + ' ' + g.label)));
    });
    var checks = el('div', { class: 'strip-checks' });
    integrityChecks().forEach(function (c) {
      checks.appendChild(el('span', { class: 'chip ' + (c.pass ? 'pass' : 'fail'), text: (c.pass ? 'PASS ' : 'FAIL ') + c.label }));
    });
    return el('section', { class: 'panel' },
      el('h2', { text: 'Protocol accounting — all ' + acc.total + ' protocols in exactly one bucket' }),
      el('p', { class: 'sub', text: acc.ranked + ' ranked, ' + acc.watchlist + ' on the watchlist. The buckets always add up to the ledger total.' }),
      bar, legend,
      el('p', { class: 'sub', text: 'Integrity, recomputed in this browser from the data file:' }),
      checks
    );
  }

  function termTable(title, intro, head, rows) {
    var tbody = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr', null);
      r.forEach(function (cell, i) { tr.appendChild(el('td', { class: i > 0 ? 'num' : '', text: cell })); });
      tbody.appendChild(tr);
    });
    return el('div', null,
      el('h3', { text: title }),
      el('p', { class: 'sub', text: intro }),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('thead', null, el('tr', null, head.map(function (h, i) { return el('th', { class: i > 0 ? 'num' : '', scope: 'col', text: h }); }))),
          tbody)));
  }
  function evidenceSection() {
    var ev = DATA.evidence || {};
    var v = ev.value || {};
    var o = ev.odds || {};
    var rg = ev.range || {};
    function num(x, d) { return (x === undefined || x === null) ? '—' : Number(x).toFixed(d === undefined ? 3 : d); }
    var valueRows = (v.terms || []).map(function (t) { return [t.name, num(t.loo), num(t.wf), t.kept]; });
    var oddsRows = (o.terms || []).map(function (t) { return [t.name, num(t.brier), num(t.wfBrier), t.kept]; });
    var rangeRows = (rg.rows || []).map(function (r) {
      return [r.label, Math.round(r.stated * 100) + '%', Math.round(r.loo * 100) + '%', Math.round(r.wf * 100) + '%'];
    });
    return el('section', { class: 'panel' },
      el('h2', { text: 'Evidence — what survived, and what did not' }),
      el('p', { class: 'sub', text: 'Every term is kept only when it lowers the miss on BOTH held-out tests. A term that helps one test and hurts the other is reported, not used.' }),
      termTable('Value model (log multiple, fitted on the ' + (v.n === undefined ? '—' : v.n) + ' dated priced rows)',
        'Baseline flat median multiple: leave-one-out ' + num(v.baselineLoo) + ', walk-forward ' + num(v.baselineWf) + '. Final: ' + num(v.finalLoo) + ' / ' + num(v.finalWf) + '.',
        ['Term', 'LOO miss', 'Walk-forward miss', 'Status'], valueRows),
      termTable('Listing-probability model (ticker recorded, n=' + (o.n === undefined ? '—' : o.n) + ', base rate ' + num(o.baseRate) + ')',
        'Baseline base rate: Brier ' + num(o.baselineBrier) + ' ten-fold, ' + num(o.baselineWfBrier) + ' walk-forward. Final: ' + num(o.finalBrier) + ' / ' + num(o.finalWfBrier) + ', ' + Math.round((o.walkForwardCorrect || 0) * 100) + '% of walk-forward calls right.',
        ['Group', 'Brier (ten-fold)', 'Brier (walk-forward)', 'Status'], oddsRows),
      termTable('Range honesty',
        (rg.note || '') + ' Coverage is the share of held-out actuals that fell inside the band.',
        ['Band', 'Stated', 'Leave-one-out', 'Walk-forward'], rangeRows)
    );
  }

  // ---- Board controls.
  function tabButtons(name, options, current, onPick) {
    var wrap = el('div', { class: 'tabs', role: 'group', 'aria-label': name });
    options.forEach(function (opt) {
      wrap.appendChild(el('button', {
        type: 'button', 'aria-pressed': current === opt[0] ? 'true' : 'false', text: opt[1],
        onclick: function () { onPick(opt[0]); render(); }
      }));
    });
    return wrap;
  }
  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, slug or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; render(); });
    function dropdown(id, label, values, current, onChange) {
      var sel = el('select', { id: id, 'aria-label': label });
      values.forEach(function (v) {
        sel.appendChild(el('option', { value: v[0], text: v[1], selected: v[0] === current ? 'selected' : null }));
      });
      sel.addEventListener('change', function () { onChange(sel.value); render(); });
      return el('div', { class: 'field' }, el('label', { for: id, text: label }), sel);
    }
    var sortSel = el('select', { id: 'sort', 'aria-label': 'Sort the board' });
    [['rank', 'Rank'], ['implied', 'Implied value'], ['tvl', 'TVL'], ['odds', 'Token odds'], ['age', 'Age'], ['name', 'Name']].forEach(function (v) {
      sortSel.appendChild(el('option', { value: v[0], text: v[1], selected: v[0] === state.sort ? 'selected' : null }));
    });
    sortSel.addEventListener('change', function () { state.sort = sortSel.value; state.dir = state.sort === 'name' ? 1 : -1; render(); });
    var drop = el('input', { type: 'range', id: 'drop', min: '1', max: '14', step: '0.5', value: String(state.dropShare), 'aria-label': 'Drop share' });
    var dropVal = el('span', { id: 'drop-val', text: state.dropShare.toFixed(1) + '%' });
    drop.addEventListener('input', function () { state.dropShare = parseFloat(drop.value); dropVal.textContent = state.dropShare.toFixed(1) + '%'; updateScenario(); });
    var horizon = el('input', { type: 'range', id: 'horizon', min: '4', max: '52', step: '1', value: String(state.horizon), 'aria-label': 'Horizon in weeks' });
    var horizonVal = el('span', { id: 'horizon-val', text: state.horizon + ' wk' });
    horizon.addEventListener('input', function () { state.horizon = parseInt(horizon.value, 10); horizonVal.textContent = state.horizon + ' wk'; updateScenario(); });
    var dep = el('select', { id: 'deposit', 'aria-label': 'Deposit' });
    [100, 500, 1000, 5000, 10000].forEach(function (d) {
      dep.appendChild(el('option', { value: String(d), text: '$' + d.toLocaleString('en-US'), selected: d === state.deposit ? 'selected' : null }));
    });
    dep.addEventListener('change', function () { state.deposit = parseInt(dep.value, 10); updateScenario(); });
    var reset = el('button', { class: 'button', type: 'button', text: 'Reset', onclick: function () {
      state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.tier = 'all';
      state.sort = 'rank'; state.dir = 1; render();
    } });
    var csvBtn = el('button', { class: 'button', type: 'button', text: 'CSV', onclick: exportCsv });
    var jsonBtn = el('button', { class: 'button', type: 'button', text: 'JSON', onclick: exportJson });
    var list = filteredRows();
    var pinNote = pinnedCount() > 0 ? ' · ' + pinnedCount() + ' pinned' : '';
    return el('div', null,
      el('div', { class: 'controls' },
        el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
        dropdown('category', 'Category', [['all', 'All categories']].concat(categories.map(function (c) { return [c, c]; })), state.category, function (v) { state.category = v; }),
        dropdown('chain', 'Chain', [['all', 'All chains']].concat(chains.map(function (c) { return [c, c]; })), state.chain, function (v) { state.chain = v; }),
        el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Verdict' }),
          tabButtons('Verdict', [['all', 'All'], ['FARM', 'Farm'], ['MARGINAL', 'Marginal'], ['SKIP', 'Skip']], state.verdict, function (v) { state.verdict = v; })),
        el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Tier' }),
          tabButtons('Tier', [['all', 'All tiers'], ['watchlist', 'Watchlist'], ['early', 'Early'], ['offlist', 'Off-list']], state.tier, function (v) { state.tier = v; })),
        el('div', { class: 'field' }, el('label', { for: 'sort', text: 'Sort' }), sortSel),
        el('div', { class: 'field' }, el('span', { class: 'sub', text: ' ' }), el('div', { class: 'tabs' }, reset, csvBtn, jsonBtn)),
        el('span', { class: 'count', text: list.length + ' rows shown' + pinNote })
      ),
      el('div', { class: 'controls' },
        el('div', { class: 'field' }, el('label', { for: 'drop', text: 'Drop share' }), el('span', null, drop, ' ', dropVal)),
        el('div', { class: 'field' }, el('label', { for: 'horizon', text: 'Horizon' }), el('span', null, horizon, ' ', horizonVal)),
        el('div', { class: 'field' }, el('label', { for: 'deposit', text: 'Deposit' }), dep)
      ),
      el('p', { class: 'scenario', id: 'scenario', text: scenarioText() })
    );
  }
  function scenarioText() {
    return 'Scenario: $' + state.deposit.toLocaleString('en-US') + ' deposit · ' + state.dropShare.toFixed(1) + '% drop · ' + state.horizon + ' weeks — display only; verdicts are costed on each row’s own plan.';
  }
  function updateScenario() {
    var node = document.getElementById('scenario');
    if (node) node.textContent = scenarioText();
  }

  // ---- Board table.
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', class: 'button', style: 'padding:2px 6px;font-size:12px', onclick: function () {
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = key === 'name' ? 1 : -1; }
        render();
      } }, label, state.sort === key ? (state.dir < 0 ? ' ↓' : ' ↑') : ''));
  }
  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () {
          state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.tier = 'all'; render();
        } })
      ));
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change7d === null ? 'n/a' : fmtPct(r.change7d);
      var growthClass = r.change7d === null ? '' : r.change7d >= 0 ? 'pos' : 'neg';
      var pin = el('input', { type: 'checkbox', 'aria-label': 'Pin ' + r.name, checked: isPinned(r) ? 'checked' : null });
      pin.addEventListener('click', function (e) { e.stopPropagation(); });
      pin.addEventListener('change', function () {
        if (pin.checked) state.pinned[r.slug] = true;
        else delete state.pinned[r.slug];
        render();
      });
      var pinCell = el('td', { onclick: function (e) { e.stopPropagation(); } }, pin);
      var tr = el('tr', {
        'aria-selected': state.selected === r.slug ? 'true' : 'false',
        class: isPinned(r) ? 'pinned' : '',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        pinCell,
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', { class: 'num', text: r.bootstrapRankLow + '–' + r.bootstrapRankHigh }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }),
          r.parentName ? el('span', { class: 'tag', text: 'Off-List · Parent ×0.48' }) : null
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvlUsd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: formatAge(r.ageDays) }),
        el('td', null, el('div', { class: 'oddsbar' },
          el('span', { class: 'track', 'aria-hidden': 'true' }, el('i', { class: 'fill', style: 'width:' + Math.round(r.tokenOdds * 100) + '%' })),
          el('span', { text: Math.round(r.tokenOdds * 100) + '%' })
        )),
        el('td', { class: 'num', text: fmtInt(r.valueIfLaunches) }),
        el('td', { class: 'num', text: fmtInt(r.impliedValueUsd) }),
        el('td', { class: 'num', text: fmtInt(r.p25) + '–' + fmtInt(r.p75) }),
        el('td', null, el('div', { class: 'verdict ' + r.verdict },
          el('span', { text: r.verdict + ' · ' + fmtSigned(r.netFees) }),
          el('span', { class: 'sub2', text: fmtInt(r.dropUsd) + ' drop − ' + fmtInt(r.feesUsd) + ' fees' })
        )),
        el('td', { class: 'num', text: (r.netPerHour >= 0 ? '$' : '-$') + Math.abs(r.netPerHour).toFixed(2) })
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan. Check a row to pin it through every filter.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: '' }),
            sortHeader('rank', 'Rank'),
            el('th', { scope: 'col', text: 'Range' }),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            el('th', { scope: 'col', text: '7D' }),
            sortHeader('age', 'Age'),
            sortHeader('odds', 'Token odds'),
            sortHeader('implied', 'If it launches'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'P25–P75' }),
            el('th', { scope: 'col', text: 'Verdict · net' }),
            el('th', { scope: 'col', text: 'Net / hour' })
          )),
          tbody
        )
      )
    );
  }

  // ---- Exports.
  function download(filename, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportCsv() {
    var cols = ['rank', 'slug', 'name', 'category', 'chains', 'tvlUsd', 'change7d', 'ageDays', 'tokenOdds', 'valueIfLaunches', 'impliedValueUsd', 'p25', 'p75', 'verdict', 'netFees', 'netPerHour'];
    var lines = [cols.join(',')];
    sortedRows(filteredRows()).forEach(function (r) {
      lines.push(cols.map(function (c) {
        var v = c === 'chains' ? (r.chains || []).join(';') : r[c];
        return csvCell(v);
      }).join(','));
    });
    download('launch-radar.csv', lines.join('\n') + '\n', 'text/csv');
  }
  function exportJson() {
    download('launch-radar.json', JSON.stringify(sortedRows(filteredRows()), null, 2) + '\n', 'application/json');
  }

  // ---- Detail view.
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; });
  function netAt(row, share, deposit) {
    if (row.tvlUsd <= 0) return -row.feesUsd;
    return Math.round(((row.impliedValueUsd * share * deposit) / row.tvlUsd - row.feesUsd) * 100) / 100;
  }
  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    dialog.textContent = '';
    var inner = el('div', { class: 'detail-inner' });
    inner.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'sub', text: 'Rank ' + row.rank + ' of ' + DATA.rows.length + ' · bootstrap rank ' + row.bootstrapRankLow + '–' + row.bootstrapRankHigh }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + (row.parentName ? ' · Off-List · Parent ×0.48 (' + row.parentName + ')' : '') + ' · listed ' + (row.ageDays === null ? 'at an unknown date' : formatAge(row.ageDays) + ' ago') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    inner.appendChild(el('div', { class: 'boxes' },
      el('div', { class: 'box' }, el('div', { class: 'label', text: 'TVL' }), el('b', { text: fmtInt(row.tvlUsd) })),
      el('div', { class: 'box' }, el('div', { class: 'label', text: '7-day change' }), el('b', { text: fmtPct(row.change7d) })),
      el('div', { class: 'box' }, el('div', { class: 'label', text: 'Token odds' }), el('b', { text: Math.round(row.tokenOdds * 100) + '%' })),
      el('div', { class: 'box' }, el('div', { class: 'label', text: 'Bootstrap range' }), el('b', { text: fmtInt(row.bootstrapLow) + ' – ' + fmtInt(row.bootstrapHigh) }))
    ));
    inner.appendChild(el('div', { class: 'big', text: fmtInt(row.impliedValueUsd) + ' implied value' }));
    inner.appendChild(el('p', { class: 'sub', text: 'How the figure is made: TVL ' + fmtInt(row.tvlUsd) + ' × fitted multiple ' + row.factors.multiple.toFixed(4) + ' (size factor ' + row.factors.size.toFixed(3) + ', category factor ' + row.factors.category.toFixed(3) + ') gives ' + fmtInt(row.valueIfLaunches) + ' if it launches; times the listing probability ' + Math.round(row.tokenOdds * 100) + '% gives the implied value. The P25–P75 band is ' + fmtInt(row.p25) + '–' + fmtInt(row.p75) + ' and P10–P90 is ' + fmtInt(row.p10) + '–' + fmtInt(row.p90) + ', from the value model’s own held-out residuals. This is an estimate, not a price.' }));
    // Nearest priced peers.
    var peerBody = el('tbody');
    (row.peers || []).forEach(function (p) {
      peerBody.appendChild(el('tr', null,
        el('td', { text: p.name }),
        el('td', { text: p.category }),
        el('td', { class: 'num', text: fmtInt(p.tvl) }),
        el('td', { class: 'num', text: fmtInt(p.mcap) }),
        el('td', { class: 'num', text: p.ratio.toFixed(4) }),
        el('td', { class: 'num', text: p.heldOut.toFixed(2) })
      ));
    });
    inner.appendChild(el('section', null,
      el('h3', { text: 'Nearest priced peers' }),
      (row.peers || []).length === 0
        ? el('p', { class: 'sub', text: 'No priced peer shares this category.' })
        : el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Peer' }), el('th', { scope: 'col', text: 'Category' }),
            el('th', { scope: 'col', class: 'num', text: 'TVL' }), el('th', { scope: 'col', class: 'num', text: 'Market cap' }),
            el('th', { scope: 'col', class: 'num', text: 'Ratio' }), el('th', { scope: 'col', class: 'num', text: 'Held-out' }))),
          peerBody)),
      el('p', { class: 'sub', text: 'Held-out is the leave-one-out model prediction over the peer’s actual cap/TVL ratio — 1.00 means the model priced the peer exactly.' })
    ));
    // Farm verdict.
    var tbill = row.depositUsd * 0.04 * (12 / 52);
    inner.appendChild(el('section', null,
      el('h3', { text: 'Farm verdict — ' + row.verdict }),
      el('p', { text: 'Plan: ' + fmtInt(row.depositUsd) + ' deposit · ' + (row.dropShare * 100).toFixed(0) + '% drop over ' + row.horizonWeeks + ' weeks · ' + fmtInt(row.dropUsd) + ' modelled drop − ' + fmtInt(row.feesUsd) + ' fees = net ' + fmtSigned(row.netFees) + ' (' + fmtSigned(row.netPerHour) + '/hour over ' + row.handsOnHours + ' hands-on hours). The same deposit earns ' + usd2.format(tbill) + ' as a 12-week T-bill; FARM needs to beat both that and $25/hour.' }),
      el('p', { class: 'sub', text: row.exitRule }),
      el('ol', { class: 'steps' }, (row.farmPlan || []).map(function (s) {
        return el('li', null, el('b', { text: s.n + '. ' + s.title + ' — ' + s.text }), el('span', { class: 'cost', text: s.cost + '. ' + s.time + '.' }));
      }))
    ));
    // Net grid by drop share × deposit.
    var shares = [0.035, 0.07, 0.14];
    var deposits = [1000, 3000, 10000, 30000];
    var gridHead = el('tr', null, el('th', { scope: 'col', text: 'Drop \\ deposit' }));
    deposits.forEach(function (d) { gridHead.appendChild(el('th', { scope: 'col', class: 'num', text: '$' + d.toLocaleString('en-US') })); });
    var gridBody = el('tbody');
    shares.forEach(function (share) {
      var tr = el('tr', null, el('td', { text: (share * 100).toFixed(1) + '%' }));
      deposits.forEach(function (d) {
        var v = netAt(row, share, d);
        tr.appendChild(el('td', { class: 'num ' + (v >= 0 ? 'pos' : 'neg'), text: fmtSigned(v) }));
      });
      gridBody.appendChild(tr);
    });
    inner.appendChild(el('section', null,
      el('h3', { text: 'Net by drop share × deposit' }),
      el('p', { class: 'sub', text: 'Modelled drop at each share and deposit, minus this row’s plan fees (' + fmtInt(row.feesUsd) + '). The verdict itself is costed on the row’s own plan, not on this grid.' }),
      el('div', { class: 'table-wrap' }, el('table', null, el('thead', null, gridHead), gridBody))
    ));
    dialog.appendChild(inner);
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(statStrip());
    shell.appendChild(accountingSection());
    shell.appendChild(evidenceSection());
    shell.appendChild(controls());
    shell.appendChild(boardTable());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
