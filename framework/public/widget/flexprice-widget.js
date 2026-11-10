/*!
 * FlexPrice AI — embeddable pricing advisor widget.
 *
 *   <script src="https://<flexprice-host>/widget/flexprice-widget.js" defer></script>
 *   <flexprice-advisor merchant="streamflix" session-token="<signed by merchant backend>"></flexprice-advisor>
 *
 * Attributes: merchant (required), session-token (optional; omit for anonymous visitors),
 * api-base (defaults to the script's origin).
 * Events: `flexprice:plan-changed` { detail: checkout }, `flexprice:cancelled`.
 */
(() => {
  const SCRIPT_ORIGIN = (() => {
    try { return new URL(document.currentScript.src).origin; } catch { return location.origin; }
  })();

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n, c = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(n ?? 0);
  const num = (n) => (Math.round(n * 10) / 10).toLocaleString('en-US');
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const PREFS = [
    ['balanced', 'Balanced'],
    ['lowest_cost', 'Lowest cost'],
    ['predictable', 'Predictable'],
    ['flexible', 'No commitment'],
  ];
  const SOURCE_LABEL = { history: 'Based on your usage history', customer_estimate: 'Based on your estimate', merchant_default: 'Typical customer scenario' };

  const STYLE = `
  :host{--fp-primary:#0070e0;--fp-bg:#fff;--fp-fg:#14213d;--fp-muted:#667085;--fp-line:#e4e7ec;--fp-soft:#f6f8fb;--fp-good:#067647;--fp-warn:#b54708;
    display:block;font-family:Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:var(--fp-fg);font-size:14px;line-height:1.45}
  *{box-sizing:border-box}
  .wrap{background:var(--fp-bg);border:1px solid var(--fp-line);border-radius:16px;padding:22px;box-shadow:0 1px 3px rgba(16,24,40,.06)}
  h2{margin:0;font-size:20px} h3{margin:0 0 8px;font-size:15px}
  .muted{color:var(--fp-muted)} .small{font-size:12px}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap} .between{justify-content:space-between}
  .badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;border-radius:999px;padding:3px 9px;background:var(--fp-soft);color:var(--fp-muted);border:1px solid var(--fp-line)}
  .badge.ai{background:#f4ebff;color:#6941c6;border-color:#e9d7fe}
  .badge.rec{background:var(--fp-primary);color:#fff;border-color:transparent}
  .badge.cur{background:#ecfdf3;color:var(--fp-good);border-color:#abefc6}
  .grid{display:grid;grid-template-columns:minmax(260px,1fr) minmax(300px,1.35fr);gap:18px;margin-top:16px}
  @media (max-width:860px){.grid{grid-template-columns:1fr}}
  .panel{border:1px solid var(--fp-line);border-radius:12px;padding:16px;background:var(--fp-bg)}
  .soft{background:var(--fp-soft)}
  input[type=range]{width:100%;accent-color:var(--fp-primary)}
  .usage-val{font-size:26px;font-weight:700}
  .seg{display:flex;border:1px solid var(--fp-line);border-radius:10px;overflow:hidden;margin-top:6px}
  .seg button{flex:1;border:0;background:none;padding:8px 4px;font:inherit;font-size:12px;cursor:pointer;color:var(--fp-muted)}
  .seg button+button{border-left:1px solid var(--fp-line)}
  .seg button.on{background:var(--fp-primary);color:#fff;font-weight:600}
  .link{background:none;border:0;color:var(--fp-primary);cursor:pointer;font:inherit;padding:0;text-decoration:underline}
  .plans{display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:12px;margin-top:16px}
  .plan{border:1.5px solid var(--fp-line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:6px;position:relative;transition:box-shadow .2s,border-color .2s;background:var(--fp-bg)}
  .plan.recommended{border-color:var(--fp-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--fp-primary) 18%,transparent)}
  .plan.flash{animation:flash 1.2s}
  @keyframes flash{0%,100%{box-shadow:0 0 0 3px color-mix(in srgb,var(--fp-primary) 18%,transparent)}50%{box-shadow:0 0 0 8px color-mix(in srgb,var(--fp-primary) 35%,transparent)}}
  .plan .name{font-weight:700;font-size:15px}
  .plan .price{font-size:13px;color:var(--fp-muted)}
  .plan .est{font-size:22px;font-weight:700;margin-top:4px}
  .plan .range{font-size:12px;color:var(--fp-muted)}
  .plan ul{margin:4px 0 0;padding-left:18px;color:var(--fp-muted);font-size:12px}
  .plan .tags{display:flex;gap:6px;flex-wrap:wrap;min-height:22px}
  .bar{height:6px;border-radius:3px;background:var(--fp-line);overflow:hidden;margin-top:4px}
  .bar i{display:block;height:100%;background:var(--fp-primary);opacity:.6}
  .btn{border:0;border-radius:10px;padding:10px 14px;font:inherit;font-weight:600;cursor:pointer;background:var(--fp-primary);color:#fff}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn.ghost{background:var(--fp-soft);color:var(--fp-fg);border:1px solid var(--fp-line)}
  .btn.full{width:100%}
  .plan .btn{margin-top:auto}
  .why{margin-top:16px;border-radius:12px;padding:16px;background:linear-gradient(135deg,color-mix(in srgb,var(--fp-primary) 8%,#fff),#fff);border:1px solid color-mix(in srgb,var(--fp-primary) 25%,var(--fp-line))}
  .why p{margin:6px 0 0}
  details{margin-top:8px} summary{cursor:pointer;color:var(--fp-muted);font-size:12px}
  details ul{margin:6px 0 0;padding-left:18px;font-size:12px;color:var(--fp-muted)}
  .chat{margin-top:16px}
  .msgs{max-height:240px;overflow:auto;display:flex;flex-direction:column;gap:8px;margin:10px 0}
  .msg{padding:9px 12px;border-radius:12px;max-width:85%;white-space:pre-wrap}
  .msg.user{align-self:flex-end;background:var(--fp-primary);color:#fff;border-bottom-right-radius:4px}
  .msg.assistant{align-self:flex-start;background:var(--fp-soft);border:1px solid var(--fp-line);border-bottom-left-radius:4px}
  .msg .src{display:block;font-size:10px;color:var(--fp-muted);margin-top:4px}
  .chat form{display:flex;gap:8px}
  .chat input{flex:1;border:1px solid var(--fp-line);border-radius:10px;padding:10px 12px;font:inherit}
  .chips{display:flex;gap:6px;flex-wrap:wrap}
  .chip{border:1px solid var(--fp-line);background:var(--fp-bg);border-radius:999px;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;color:var(--fp-muted)}
  .notice{font-size:12px;padding:8px 10px;border-radius:8px;background:#fffaeb;color:var(--fp-warn);border:1px solid #fedf89;margin-top:10px}
  .ok{background:#ecfdf3;color:var(--fp-good);border-color:#abefc6}
  .modal-bg{position:fixed;inset:0;background:rgba(16,24,40,.55);display:flex;align-items:center;justify-content:center;z-index:2147483000;padding:16px}
  .modal{background:#fff;border-radius:16px;width:min(560px,100%);max-height:92vh;overflow:auto;padding:22px;position:relative}
  .modal .x{position:absolute;right:14px;top:10px;border:0;background:none;font-size:22px;cursor:pointer;color:var(--fp-muted)}
  table.terms{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}
  table.terms td{padding:7px 0;border-bottom:1px solid var(--fp-line);vertical-align:top}
  table.terms td:first-child{color:var(--fp-muted);width:44%}
  .pp-btn{width:100%;border:0;border-radius:24px;padding:12px;background:#ffc439;font-weight:800;font-style:italic;font-size:17px;cursor:pointer;color:#003087}
  .pp-btn span{color:#009cde}
  .pp-btn:disabled{opacity:.5;cursor:not-allowed}
  iframe.pp{width:100%;height:470px;border:1px solid var(--fp-line);border-radius:12px}
  .alts{display:grid;gap:8px;margin:10px 0}
  .alt{border:1px solid var(--fp-line);border-radius:10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px}
  .spin{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .meter{margin-top:16px}
  svg text{font-family:inherit}
  `;

  class FlexPriceAdvisor extends HTMLElement {
    static get observedAttributes() { return ['session-token', 'merchant']; }

    constructor() {
      super();
      this.root = this.attachShadow({ mode: 'open' });
      this.state = { usage: null, preference: 'balanced', chat: [], loading: true, explaining: false };
      this.onMessage = this.onMessage.bind(this);
      this.refreshDebounced = debounce(() => this.refresh(), 220);
    }

    connectedCallback() { window.addEventListener('message', this.onMessage); this.init(); }
    disconnectedCallback() { window.removeEventListener('message', this.onMessage); }
    attributeChangedCallback(_n, oldV, newV) { if (this.isConnected && oldV !== null && oldV !== newV) { this.state = { usage: null, preference: 'balanced', chat: [], loading: true }; this.init(); } }

    get apiBase() { return (this.getAttribute('api-base') || SCRIPT_ORIGIN).replace(/\/$/, ''); }
    get merchant() { return this.getAttribute('merchant'); }
    get token() { return this.getAttribute('session-token') || ''; }

    async api(method, path, body) {
      const res = await fetch(`${this.apiBase}/api/v1/widget/${encodeURIComponent(this.merchant)}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(this.token ? { 'X-FlexPrice-Session': this.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(json.error || `Request failed (${res.status})`), { status: res.status, body: json });
      return json;
    }

    async init() {
      this.renderShell('<div class="muted"><span class="spin"></span> Loading plans…</div>');
      try {
        this.config = await this.api('GET', '/config');
        if (this.config.branding?.primary) this.style.setProperty('--fp-primary', this.config.branding.primary);
        await this.refresh('view');
        this.loadMeter();
      } catch (err) {
        this.renderShell(`<div class="notice">FlexPrice could not load: ${esc(err.message)}</div>`);
      }
    }

    /**
     * view: first load / after a plan change — served from the precomputed snapshot, counted as an
     *       impression, explanation from the snapshot (AI generated at most once per snapshot).
     * what-if: slider or preference change — computed on the fly (~0.05 ms server-side), no
     *       merchant calls, no analytics row, template explanation; AI only if the customer asks.
     */
    async refresh(kind = 'what-if') {
      const seq = (this.seq = (this.seq || 0) + 1);
      const isView = kind === 'view';
      const body = { monthly_usage: this.state.usage, preference: this.state.preference, explain: isView ? false : 'template', record: isView };
      const data = await this.api('POST', '/recommend', body);
      if (seq !== this.seq) return;
      if (isView) this.viewRecommendationId = data.recommendation.recommendation_id;
      this.data = data;
      if (this.state.usage == null) this.state.historyUsage = data.forecast.summary.expected_monthly;
      this.state.loading = false;
      this.render();
      if (isView) this.explain({ monthly_usage: null, preference: this.state.preference }, seq);
    }

    async explain(body, seq) {
      this.state.explaining = true;
      this.renderWhy();
      try {
        const ex = await this.api('POST', '/explain', { ...body, explain: true });
        if (seq !== this.seq) return;
        this.data.explanation = ex;
      } catch { /* deterministic factors remain visible */ }
      this.state.explaining = false;
      this.renderWhy();
    }

    renderShell(inner) {
      // The modal lives outside the re-rendered area so background refreshes never close it.
      if (!this.root.getElementById('main')) this.root.innerHTML = `<style>${STYLE}</style><div class="wrap" id="main"></div><div id="modal"></div>`;
      this.root.getElementById('main').innerHTML = inner;
    }

    // ------------------------------------------------------------------ main render
    render() {
      const d = this.data;
      const c = this.config;
      const f = d.forecast;
      const usageVal = this.state.usage ?? f.summary.expected_monthly;
      const max = Math.max(c.usage?.slider_max ?? 100, Math.ceil(usageVal * 1.2));
      const cust = d.customer;
      const canCancel = cust && c.capabilities.cancel_subscription && cust.current_plan_id && cust.subscription_status === 'active';

      this.renderShell(`
        <div class="row between">
          <div>
            <h2>Find the plan that fits how you use ${esc(c.name)}</h2>
            <div class="muted small" style="margin-top:4px">${cust ? `Hi ${esc(cust.display_name || 'there')} · ` : ''}Compare fixed, annual and pay-as-you-go pricing for your usage.</div>
          </div>
          <div class="row" style="gap:6px">
            <span class="badge">${esc(SOURCE_LABEL[f.source])}</span>
            <span class="badge ai" title="${c.ai.enabled ? 'Explanations by ' + esc(c.ai.model) : 'AI disabled — deterministic explanations'}">✦ ${c.ai.enabled ? 'AI advisor' : 'Advisor'}</span>
          </div>
        </div>

        <div class="grid">
          <div class="panel soft">
            <h3>Your usage</h3>
            ${d.history.length ? this.historyChart(d.history, f) : `<div class="muted small">No usage history available${cust ? '' : ' — sign in for a personalised forecast'}. Tell us what you expect below.</div>`}
            <div style="margin-top:12px">
              <div class="row between"><span class="muted small">Expected ${esc(c.usage?.label ?? 'usage per month')}</span>
                ${this.state.usage != null && d.history.length ? `<button class="link small" data-act="reset-usage">Use my history (${num(this.state.historyUsage ?? 0)})</button>` : ''}</div>
              <div class="usage-val" id="usage-val">${num(usageVal)} <span class="small muted">${esc(c.usage?.unit ?? '')}</span></div>
              <input type="range" id="usage" min="0" max="${max}" step="${max > 150 ? 1 : 0.5}" value="${usageVal}" aria-label="Expected monthly usage">
              <div class="small muted">Likely range: ${num(f.summary.low_monthly)}–${num(f.summary.high_monthly)} ${esc(c.usage?.unit ?? '')}/month · forecast confidence: <b>${esc(f.confidence)}</b></div>
            </div>
            <div style="margin-top:14px">
              <div class="muted small">What matters most to you?</div>
              <div class="seg">${PREFS.map(([k, l]) => `<button data-pref="${k}" class="${this.state.preference === k ? 'on' : ''}">${l}</button>`).join('')}</div>
            </div>
            ${f.notes.map((n) => `<div class="small muted" style="margin-top:8px">ⓘ ${esc(n)}</div>`).join('')}
            ${(d.warnings || []).map((w) => `<div class="notice">${esc(w)}</div>`).join('')}
          </div>

          <div>
            <div id="why"></div>
            ${this.chatPanel()}
          </div>
        </div>

        <div class="plans">${this.planCards()}</div>
        ${d.excluded_plans?.length ? `<div class="small muted" style="margin-top:10px">Not shown: ${d.excluded_plans.map((x) => `${esc(x.plan_name ?? x.plan_id)} (${esc(x.reason)})`).join(', ')}</div>` : ''}
        <div class="small muted" style="margin-top:10px">Estimates use the same ${d.recommendation.comparison_period.months}-month period for every plan and are not guaranteed prices. Usage-based charges depend on actual usage and never exceed a plan's spending cap.</div>
        <div id="meter"></div>
        <div class="row between" style="margin-top:14px">
          <span class="small muted">${c.capabilities.change_plan ? `Payments securely processed by PayPal${c.paypal.mode === 'simulator' ? ' (sandbox simulator)' : c.paypal.mode === 'sandbox' ? ' (sandbox)' : ''} · ` : `Checkout completed on ${esc(c.name)}'s site · `}Powered by FlexPrice AI</span>
          ${canCancel ? '<button class="link small" data-act="cancel">Thinking of cancelling?</button>' : ''}
        </div>
      `);
      this.renderWhy();
      this.renderMeter();
      this.bind();
      this.scrollChat();
    }

    planName(id) { return this.data.plans.find((p) => p.plan_id === id)?.name ?? id; }

    priceLabel(p) {
      const c = p.currency;
      if (p.billing_model === 'fixed') return p.billing_interval === 'year' ? `${money(p.base_price, c)}/year (${money(p.base_price / 12, c)}/mo)` : `${money(p.base_price, c)}/month`;
      if (p.billing_model === 'usage') return `${money(p.unit_price, c)} per ${p.unit?.replace(/s$/, '') ?? 'unit'}${p.minimum_charge ? ` · min ${money(p.minimum_charge, c)}` : ''}`;
      if (p.billing_model === 'hybrid') return `${money(p.base_price, c)}/mo incl. ${p.included_usage} ${p.unit} + ${money(p.unit_price, c)} each extra`;
      return `From ${money(p.tier_rules[0].unit_price, c)} per ${p.unit}, volume tiers`;
    }

    planCards() {
      const r = this.data.recommendation;
      const ests = Object.fromEntries(r.ranked_plans.map((e) => [e.plan_id, e]));
      const maxCost = Math.max(...r.ranked_plans.map((e) => e.high_cost_scenario));
      const cur = this.data.customer?.current_plan_id;
      const order = this.data.plans.map((p) => p.plan_id);
      return order.map((id) => {
        const p = this.data.plans.find((x) => x.plan_id === id);
        const e = ests[id];
        if (!e) return '';
        const isRec = id === r.recommended_plan_id;
        const isCur = id === cur;
        const variable = e.cost_variability > 0;
        return `<div class="plan ${isRec ? 'recommended' : ''}" data-plan="${esc(id)}">
          <div class="tags">${isRec ? '<span class="badge rec">★ Recommended</span>' : ''}${isCur ? '<span class="badge cur">Current plan</span>' : ''}${p.terms.commitment_months ? `<span class="badge">${p.terms.commitment_months}-mo commitment</span>` : ''}${p.spending_cap != null ? `<span class="badge">Cap ${money(p.spending_cap, p.currency)}</span>` : ''}</div>
          <div class="name">${esc(p.name)}</div>
          <div class="price">${esc(this.priceLabel(p))}</div>
          <div class="est">${money(e.estimated_monthly_cost, e.currency)}<span class="small muted" style="font-weight:400">/mo est.</span></div>
          <div class="range">${variable ? `12-mo: ${money(e.low_cost_scenario)}–${money(e.high_cost_scenario)} (exp. ${money(e.estimated_cost)})` : `12-mo: ${money(e.estimated_cost)} · ${p.billing_model === 'fixed' ? 'fixed price' : e.months_at_cap ? 'at spending cap every month' : 'minimum charge'}`}</div>
          <div class="bar" title="Relative 12-month cost"><i style="width:${Math.max(4, (e.estimated_cost / maxCost) * 100)}%"></i></div>
          <ul>${(p.features || []).slice(0, 3).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          ${this.selectButton(p, isCur)}
        </div>`;
      }).join('');
    }

    selectButton(p, isCur) {
      if (isCur) return '<button class="btn ghost full" disabled>Your current plan</button>';
      if (!this.config.capabilities.change_plan) {
        return this.config.checkout_url ? `<a class="btn full" style="text-align:center;text-decoration:none" target="_blank" rel="noopener" href="${esc(this.config.checkout_url)}?plan=${encodeURIComponent(p.plan_id)}">Continue to checkout</a>` : '';
      }
      if (!this.token) return '<button class="btn ghost full" disabled title="Sign in to choose a plan">Sign in to choose</button>';
      return `<button class="btn full" data-choose="${esc(p.plan_id)}">Choose plan</button>`;
    }

    historyChart(history, f) {
      const hist = history.slice(-12);
      const fc = f.history_forecast ? { exp: f.history_forecast.expected.slice(0, 3), lo: f.history_forecast.low.slice(0, 3), hi: f.history_forecast.high.slice(0, 3), periods: f.periods.slice(0, 3) } : null;
      const all = [...hist.map((h) => h.quantity), ...(fc ? fc.hi : [])];
      const max = Math.max(1, ...all) * 1.1;
      const n = hist.length + (fc ? fc.exp.length : 0);
      const W = 320, H = 110, pad = 18, bw = (W - pad) / n;
      const y = (v) => H - 14 - (v / max) * (H - 24);
      const bars = hist.map((h, i) => `<rect x="${pad + i * bw + 2}" y="${y(h.quantity)}" width="${bw - 4}" height="${H - 14 - y(h.quantity)}" rx="2" fill="#98a2b3"><title>${h.period}: ${h.quantity}</title></rect>`).join('');
      const fbars = fc ? fc.exp.map((v, j) => {
        const i = hist.length + j; const x = pad + i * bw + 2;
        return `<rect x="${x}" y="${y(v)}" width="${bw - 4}" height="${H - 14 - y(v)}" rx="2" fill="var(--fp-primary)" opacity=".55"><title>Forecast ${fc.periods[j]}: ${v} (${fc.lo[j]}–${fc.hi[j]})</title></rect>
          <line x1="${x + (bw - 4) / 2}" x2="${x + (bw - 4) / 2}" y1="${y(fc.hi[j])}" y2="${y(fc.lo[j])}" stroke="var(--fp-primary)" stroke-width="1.5"/>`;
      }).join('') : '';
      const labels = [hist[0], hist.at(-1)].map((h, k) => `<text x="${k ? pad + (hist.length - 1) * bw + bw / 2 : pad + bw / 2}" y="${H - 2}" font-size="9" fill="#667085" text-anchor="middle">${h.period.slice(2)}</text>`).join('');
      return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Monthly usage history and forecast">
        <text x="0" y="10" font-size="9" fill="#667085">${num(max / 1.1)}</text>
        ${bars}${fbars}${labels}
        ${fc ? `<text x="${pad + hist.length * bw}" y="10" font-size="9" fill="var(--fp-primary)">forecast →</text>` : ''}
      </svg>
      <div class="small muted">${hist.length} months of history · avg ${num(f.history_forecast?.historical_average ?? 0)} · trend ${esc(f.history_forecast?.trend ?? 'n/a')}${f.history_forecast?.seasonality_applied ? ' · seasonal' : ''}</div>`;
    }

    renderWhy() {
      const el = this.root.getElementById('why');
      if (!el || !this.data) return;
      const r = this.data.recommendation;
      const ex = this.data.explanation;
      const srcLabel = ex ? (ex.source === 'claude' ? `✦ Explained by Claude · numbers verified against pricing engine` : ex.grounding_rejected ? 'AI draft failed number verification — showing engine summary' : 'Generated from pricing engine') : '';
      el.innerHTML = `<div class="why">
        <div class="row between"><h3 style="margin:0">Why ${esc(r.recommended_plan_name)}?</h3>
          ${r.estimated_savings > 0 ? `<span class="badge cur">Save ~${money(r.estimated_savings)} / ${r.comparison_period.months} mo</span>` : ''}</div>
        <p>${this.state.explaining && !ex ? '<span class="spin"></span> Thinking…' : esc(ex?.text ?? r.decision_factors.map((f) => f.detail).join(' '))}</p>
        ${this.state.explaining && ex ? '<div class="small muted"><span class="spin"></span> updating…</div>' : ''}
        <div class="small muted" style="margin-top:6px">${esc(srcLabel)}${this.config.ai.enabled && ex?.source === 'template' && !this.state.explaining ? ` · <button class="link small" data-act="ai-explain">✦ Explain this with AI</button>` : ''}</div>
        ${this.data.served ? `<div class="small muted">${this.data.served.recommendation === 'precomputed' ? `Precomputed ${this.data.served.computed_at ? new Date(this.data.served.computed_at).toLocaleTimeString() : ''}` : 'Computed now'} · merchant data ${this.data.served.merchant_data === 'hit' ? 'from cache' : this.data.served.merchant_data === 'miss' ? 'fetched' : 'n/a'}</div>` : ''}
        <details><summary>How we decided (${r.decision_factors.length} factors · forecast confidence ${esc(r.confidence_or_uncertainty.forecast_confidence)})</summary>
          <ul>${r.decision_factors.map((f) => `<li>${esc(f.detail)}</li>`).join('')}<li>${esc(r.confidence_or_uncertainty.note)}</li></ul>
        </details>
      </div>`;
      el.querySelector('[data-act="ai-explain"]')?.addEventListener('click', () => this.explain({ monthly_usage: this.state.usage, preference: this.state.preference }, this.seq));
    }

    chatPanel() {
      const examples = {
        saas: ['We expect about 80k calls a month', 'I want predictable bills', 'What if usage doubles?'],
        education: ['About 3 lessons a week', 'I want the cheapest option', 'Is annual worth it?'],
      }[this.config.vertical] ?? ['I watch about 2 movies a week', 'I prefer predictable bills', 'Is annual worth it?'];
      return `<div class="panel chat">
        <div class="row between"><h3 style="margin:0">Ask the advisor</h3><span class="small muted">The advisor can't change your plan or charge you</span></div>
        <div class="msgs" id="msgs">${this.state.chat.map((m) => `<div class="msg ${m.role}">${esc(m.content)}${m.role === 'assistant' && m.source ? `<span class="src">${m.source === 'claude' ? '✦ Claude · grounded in pricing engine' : 'rule-based advisor'}</span>` : ''}</div>`).join('') || `<div class="chips">${examples.map((e) => `<button class="chip" data-ask="${esc(e)}">${esc(e)}</button>`).join('')}</div>`}
          ${this.state.chatBusy ? '<div class="msg assistant"><span class="spin"></span></div>' : ''}</div>
        <form id="chatform"><input id="chatin" maxlength="500" placeholder="Describe how you use ${esc(this.config.name)}…" autocomplete="off"><button class="btn" ${this.state.chatBusy ? 'disabled' : ''}>Ask</button></form>
      </div>`;
    }

    scrollChat() { const m = this.root.getElementById('msgs'); if (m) m.scrollTop = m.scrollHeight; }

    bind() {
      const $ = (s) => this.root.querySelector(s);
      const slider = $('#usage');
      slider?.addEventListener('input', () => {
        this.state.usage = Number(slider.value);
        $('#usage-val').firstChild.textContent = `${num(this.state.usage)} `;
        this.refreshDebounced();
      });
      this.root.querySelectorAll('[data-pref]').forEach((b) => b.addEventListener('click', () => { this.state.preference = b.dataset.pref; this.refresh(); }));
      this.root.querySelectorAll('[data-choose]').forEach((b) => b.addEventListener('click', () => this.openCheckout(b.dataset.choose)));
      this.root.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', () => this.ask(b.dataset.ask)));
      $('[data-act="reset-usage"]')?.addEventListener('click', () => { this.state.usage = null; this.refresh(); });
      $('[data-act="cancel"]')?.addEventListener('click', () => this.openRetention());
      $('#chatform')?.addEventListener('submit', (e) => { e.preventDefault(); const v = $('#chatin').value.trim(); if (v) this.ask(v); });
    }

    // ------------------------------------------------------------------ chat
    async ask(text) {
      this.state.chat.push({ role: 'user', content: text });
      this.state.chatBusy = true;
      this.render();
      try {
        const out = await this.api('POST', '/chat', { message: text, history: this.state.chat.slice(0, -1).map(({ role, content }) => ({ role, content })) });
        this.state.chat.push({ role: 'assistant', content: out.reply, source: out.source });
        this.state.chatBusy = false;
        let changed = false;
        let highlight = null;
        for (const a of out.actions || []) {
          if (a.type === 'set_usage') { this.state.usage = a.value; changed = true; }
          if (a.type === 'set_preference') { this.state.preference = a.value; changed = true; }
          if (a.type === 'highlight_plan') highlight = a.plan_id;
          if (a.type === 'show_retention') setTimeout(() => this.openRetention(), 400);
        }
        if (changed) await this.refresh(); else this.render();
        if (highlight) {
          const el = this.root.querySelector(`[data-plan="${CSS.escape(highlight)}"]`);
          el?.classList.add('flash');
          setTimeout(() => el?.classList.remove('flash'), 1300);
        }
      } catch (err) {
        this.state.chatBusy = false;
        this.state.chat.push({ role: 'assistant', content: `Sorry — ${err.message}` });
        this.render();
      }
    }

    // ------------------------------------------------------------------ modal helpers
    modal(html) {
      const m = this.root.getElementById('modal');
      m.innerHTML = html ? `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true"><button class="x" aria-label="Close">×</button>${html}</div></div>` : '';
      m.querySelector('.x')?.addEventListener('click', () => this.closeModal());
      m.querySelector('.modal-bg')?.addEventListener('click', (e) => { if (e.target.classList.contains('modal-bg')) this.closeModal(); });
      return m;
    }
    closeModal() { this.modal(''); this.pending = null; }

    // ------------------------------------------------------------------ checkout
    async openCheckout(planId, context = 'advisor') {
      const plan = this.data.plans.find((p) => p.plan_id === planId);
      const est = this.data.recommendation.ranked_plans.find((p) => p.plan_id === planId);
      const m = this.modal('<div class="muted"><span class="spin"></span> Loading terms…</div>');
      let terms;
      try { terms = await this.api('GET', `/plans/${encodeURIComponent(planId)}/terms`); } catch (err) { m.querySelector('.modal').innerHTML += `<div class="notice">${esc(err.message)}</div>`; return; }
      const d = terms.disclosure;
      const c = d.currency;
      const pr = d.proration;
      const rows = [
        pr ? ['Plan price', `${money(d.due_today_gross, c)} — ${esc(d.due_today_description)}`] : null,
        pr ? ['Credit for unused time', `−${money(pr.applied_today, c)} · ${pr.unused_days} of ${pr.period_days} days left on ${esc(pr.from_plan_name)}${pr.carried_forward > 0 ? ` (+${money(pr.carried_forward, c)} kept as account credit for future bills)` : ''}`] : null,
        ['Due today', `<b>${money(d.due_today, c)}</b>${pr ? '' : ` — ${esc(d.due_today_description)}`}`],
        d.pending_usage_note ? ['Current usage', esc(d.pending_usage_note)] : null,
        ['Billing frequency', esc(d.billing_frequency)],
        d.base_price ? ['Base price', `${money(d.base_price, c)} / ${d.billing_frequency === 'yearly' ? 'year' : 'month'}`] : null,
        d.usage_formula ? ['Usage rate', esc(d.usage_formula)] : null,
        d.minimum_charge ? ['Minimum monthly charge', money(d.minimum_charge, c)] : null,
        d.spending_cap != null ? ['Spending cap', `${money(d.spending_cap, c)} per month — you are never charged more`] : null,
        ['Commitment', d.commitment_months ? `${d.commitment_months} months, paid up-front` : 'None — cancel anytime'],
        ['Renewal', d.auto_renews ? 'Renews automatically until cancelled' : 'Does not renew'],
        est ? ['Your estimated cost', `${money(est.estimated_monthly_cost, c)}/month (estimate, not a guarantee)`] : null,
        d.future_charges ? [d.future_charges.amount_per_renewal != null ? 'Renewals' : 'Usage billing', d.future_charges.amount_per_renewal != null ? `${money(d.future_charges.amount_per_renewal, c)} charged to your saved PayPal account each ${d.billing_frequency === 'yearly' ? 'year' : 'month'}; reminder ${d.future_charges.notice_days} day(s) before` : `Charged to your saved PayPal account after each month, ${d.future_charges.notice_days} day(s) after you're notified`] : null,
      ].filter(Boolean);
      this.pending = { planId, terms, context };
      const box = this.modal(`
        <h2>${esc(d.plan_name)}</h2>
        <div class="muted small">${esc(d.terms_summary ?? '')}</div>
        <table class="terms">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
        <label class="row small" style="gap:8px;align-items:flex-start"><input type="checkbox" id="agree" style="margin-top:3px"> <span>I have reviewed the amount, billing frequency${d.usage_formula ? ', usage rate and spending cap' : ''} and renewal terms, and I agree to them.${d.future_charges ? ` <b>${esc(d.future_charges.authorization)}</b>` : ''}</span></label>
        <div id="pay" style="margin-top:14px"></div>
        <div id="pay-msg"></div>
      `);
      const agree = box.querySelector('#agree');
      const pay = box.querySelector('#pay');
      const mode = this.config.paypal.mode;
      const needsPayPal = d.due_today > 0 || d.future_charges;
      const renderPay = () => {
        if (needsPayPal && mode === 'disabled') {
          pay.innerHTML = '<div class="notice">Online payment is not enabled for this merchant yet.</div>';
        } else if (d.due_today === 0 && d.future_charges && mode === 'simulator') {
          pay.innerHTML = `<button class="pp-btn" id="ppsim" ${agree.checked ? '' : 'disabled'}>Save Pay<span>Pal</span> for future billing</button><div class="small muted" style="text-align:center;margin-top:6px">Nothing is charged today · sandbox simulator</div>`;
          pay.querySelector('#ppsim').onclick = () => this.startCheckout();
        } else if (d.due_today === 0 && d.future_charges) {
          this.renderPayPalVaultButtons(pay, agree);
        } else if (d.due_today === 0) {
          pay.innerHTML = `<button class="btn full" id="confirm" ${agree.checked ? '' : 'disabled'}>Confirm switch — nothing due today</button>`;
          pay.querySelector('#confirm').onclick = () => this.startCheckout();
        } else if (mode === 'simulator') {
          pay.innerHTML = `<button class="pp-btn" id="ppsim" ${agree.checked ? '' : 'disabled'}>Pay<span>Pal</span></button><div class="small muted" style="text-align:center;margin-top:6px">Sandbox simulator — no real money moves</div>`;
          pay.querySelector('#ppsim').onclick = () => this.startCheckout();
        } else {
          this.renderPayPalButtons(pay, agree);
        }
      };
      agree.addEventListener('change', renderPay);
      renderPay();
    }

    async ensureConsent() {
      const p = this.pending;
      if (p.consentId) return p.consentId;
      const rec = this.data.recommendation;
      const consent = await this.api('POST', '/consents', { plan_id: p.planId, terms_hash: p.terms.terms_hash, recommendation_id: rec.recommendation_id ?? this.viewRecommendationId });
      p.consentId = consent.consent_id;
      return p.consentId;
    }

    payMsg(html, cls = '') { const el = this.root.getElementById('pay-msg'); if (el) el.innerHTML = html ? `<div class="notice ${cls}">${html}</div>` : ''; }

    /** Simulator / $0 path: create order on our server, then show PayPal approval in an iframe. */
    async startCheckout() {
      const pay = this.root.getElementById('pay');
      pay.innerHTML = '<div class="muted"><span class="spin"></span> Creating secure PayPal order…</div>';
      try {
        await this.ensureConsent();
        const co = await this.api('POST', '/checkout', { plan_id: this.pending.planId, consent_id: this.pending.consentId, context: this.pending.context });
        this.pending.checkout = co;
        if (co.status === 'completed') return this.success(co);
        if (!['created', 'awaiting_payment_method'].includes(co.status) || !co.approve_url) throw new Error(`Unexpected checkout state ${co.status}`);
        pay.innerHTML = `<iframe class="pp" src="${esc(co.approve_url)}" title="PayPal checkout"></iframe>`;
      } catch (err) {
        pay.innerHTML = '';
        this.payMsg(esc(err.message));
      }
    }

    /** Real PayPal JS SDK buttons (sandbox/live). Order is created & captured server-side. */
    async renderPayPalButtons(container, agree) {
      container.innerHTML = '<div id="pp-buttons"></div>';
      try {
        await this.loadPayPalSdk();
        // eslint-disable-next-line no-undef
        window.paypal.Buttons({
          style: { layout: 'vertical', shape: 'pill', label: 'pay' },
          onInit: (_d, actions) => { agree.checked ? actions.enable() : actions.disable(); agree.addEventListener('change', () => (agree.checked ? actions.enable() : actions.disable())); },
          createOrder: async () => {
            await this.ensureConsent();
            const co = await this.api('POST', '/checkout', { plan_id: this.pending.planId, consent_id: this.pending.consentId, context: this.pending.context });
            this.pending.checkout = co;
            return co.paypal_order_id;
          },
          onApprove: async (data) => this.capture(data.orderID),
          onCancel: () => this.payMsg('Payment cancelled — you have not been charged.'),
          onError: (err) => this.payMsg(`PayPal error: ${esc(err?.message || err)}`),
        }).render(this.root.getElementById('pp-buttons'));
      } catch (err) {
        this.payMsg(`Could not load PayPal: ${esc(err.message)}`);
      }
    }

    /** Real PayPal JS SDK "save PayPal" flow (Vault v3 setup token) for $0-due metered plans. */
    async renderPayPalVaultButtons(container, agree) {
      container.innerHTML = '<div id="pp-buttons"></div>';
      try {
        await this.loadPayPalSdk('paypalVault');
        window.paypalVault.Buttons({
          style: { layout: 'vertical', shape: 'pill' },
          onInit: (_d, actions) => { agree.checked ? actions.enable() : actions.disable(); agree.addEventListener('change', () => (agree.checked ? actions.enable() : actions.disable())); },
          createVaultSetupToken: async () => {
            await this.ensureConsent();
            const co = await this.api('POST', '/checkout', { plan_id: this.pending.planId, consent_id: this.pending.consentId, context: this.pending.context });
            this.pending.checkout = co;
            return co.setup_token_id;
          },
          onApprove: async () => this.completeVault(),
          onCancel: () => this.payMsg('Cancelled — nothing was saved or charged.'),
          onError: (err) => this.payMsg(`PayPal error: ${esc(err?.message || err)}`),
        }).render(this.root.getElementById('pp-buttons'));
      } catch (err) {
        this.payMsg(`Could not load PayPal: ${esc(err.message)}`);
      }
    }

    async completeVault() {
      const pay = this.root.getElementById('pay');
      if (pay) pay.innerHTML = '<div class="muted"><span class="spin"></span> Saving PayPal and switching plan…</div>';
      try {
        const co = await this.api('POST', `/checkout/${encodeURIComponent(this.pending.checkout.checkout_id)}/payment-method`);
        if (co.status === 'completed') return this.success(co);
        throw new Error(`Status: ${co.status}`);
      } catch (err) {
        if (pay) pay.innerHTML = '';
        this.payMsg(esc(err.message));
      }
    }

    /** Orders checkout uses intent=capture; the vault flow needs a separate SDK instance (namespace). */
    loadPayPalSdk(namespace = 'paypal') {
      if (window[namespace]?.Buttons) return Promise.resolve();
      this._sdk ??= {};
      if (this._sdk[namespace]) return this._sdk[namespace];
      this._sdk[namespace] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        const params = namespace === 'paypal' ? '&currency=USD&intent=capture&components=buttons' : '&components=buttons';
        s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(this.config.paypal.client_id)}${params}`;
        s.dataset.namespace = namespace;
        s.onload = resolve;
        s.onerror = () => reject(new Error('PayPal SDK failed to load'));
        document.head.appendChild(s);
      });
      return this._sdk[namespace];
    }

    /** Approval messages from the demo's PayPal simulator page (only used in simulator mode). */
    onMessage(e) {
      const msg = e.data;
      const co = this.pending?.checkout;
      if (!msg || msg.source !== 'paypal-sim' || !co || e.origin !== new URL(this.apiBase).origin) return;
      if (msg.setupTokenID ? msg.setupTokenID !== co.setup_token_id : msg.orderID !== co.paypal_order_id) return;
      if (msg.type === 'approved') msg.setupTokenID ? this.completeVault() : this.capture(msg.orderID);
      else { this.root.getElementById('pay').innerHTML = ''; this.payMsg('Payment cancelled — you have not been charged.'); setTimeout(() => this.openCheckout(this.pending.planId, this.pending.context), 1200); }
    }

    async capture(orderId) {
      const pay = this.root.getElementById('pay');
      if (pay) pay.innerHTML = '<div class="muted"><span class="spin"></span> Verifying payment with PayPal…</div>';
      try {
        const co = await this.api('POST', `/checkout/${encodeURIComponent(orderId)}/capture`);
        if (co.status === 'completed') return this.success(co);
        if (co.status === 'paid_pending_fulfillment') { this.payMsg('Payment received. Your plan change is being finalised by the merchant — you will not be charged again.'); return; }
        throw new Error(`Payment status: ${co.status}`);
      } catch (err) {
        if (pay) pay.innerHTML = '';
        const declined = /declined/i.test(err.message);
        this.payMsg(`${esc(declined ? 'Your payment method was declined. You have not been charged — please try another method.' : err.message)}`);
        if (declined) setTimeout(() => this.openCheckout(this.pending.planId, this.pending.context), 1800);
      }
    }

    success(co) {
      if (this.pending?.invoice) {
        this.modal(`<div style="text-align:center"><div style="font-size:42px">✅</div><h2>Invoice paid</h2><p class="muted">${money(co.amount, co.currency)} captured via PayPal (<code>${esc(co.capture_id)}</code>).</p><button class="btn" id="done">Done</button></div>`);
        this.root.getElementById('done').onclick = () => this.closeModal();
        this.loadMeter();
        return;
      }
      this.modal(`
        <div style="text-align:center;padding:10px 0">
          <div style="font-size:42px">✅</div>
          <h2>You're on ${esc(this.planName(co.plan_id))}</h2>
          <p class="muted">${co.amount > 0 ? `${money(co.amount, co.currency)} paid via PayPal · capture <code>${esc(co.capture_id)}</code>` : co.setup_token_id ? 'Nothing charged today · PayPal saved for future billing.' : co.proration_credit ? `Nothing due today — covered by your ${money(co.proration_credit)} credit for unused time.` : 'No payment due today.'}${co.amount > 0 && co.proration_credit ? `<br>Includes a ${money(co.proration_credit)} credit for unused time on your previous plan.` : ''}<br>
          Subscription verified with ${esc(this.config.name)}: <b>${esc(co.subscription?.status ?? 'active')}</b></p>
          <button class="btn" id="done">Done</button>
        </div>`);
      this.root.getElementById('done').onclick = () => this.closeModal();
      this.dispatchEvent(new CustomEvent('flexprice:plan-changed', { detail: co, bubbles: true, composed: true }));
      this.state.usage = null;
      this.refresh('view');
      this.loadMeter();
    }

    // ------------------------------------------------------------------ retention
    async openRetention() {
      const m = this.modal('<div class="muted"><span class="spin"></span> Finding options for you…</div>');
      let o;
      try { o = await this.api('POST', '/retention/options'); } catch (err) { m.querySelector('.modal').innerHTML += `<div class="notice">${esc(err.message)}</div>`; return; }
      const alts = o.alternatives.slice(0, 3);
      const box = this.modal(`
        <h2>Before you go</h2>
        <p class="muted">You're paying about <b>${money(o.current_estimated_monthly_cost)}/month</b> on ${esc(this.planName(o.current_plan_id))}. Based on your usage, these options might suit you better. No pressure — you can cancel below.</p>
        ${alts.length ? `<h3>Switch to a plan that fits your usage</h3><div class="alts">${alts.map((a) => `<div class="alt"><div><b>${esc(a.plan_name)}</b><div class="small muted">~${money(a.estimated_monthly_cost)}/mo for you${a.savings_vs_current > 0 ? ` · save ~${money(a.savings_vs_current)}/yr` : ''}${a.upfront_payment ? ` · ${money(a.upfront_payment)} up-front` : ''}</div></div><button class="btn" data-switch="${esc(a.plan_id)}">Switch</button></div>`).join('')}</div>` : ''}
        ${o.pause.eligible ? `<div class="alt"><div><b>Pause instead</b><div class="small muted">Keep your account and history; pause for up to ${o.pause.max_months} month(s).</div></div><button class="btn ghost" data-ret="pause">Pause 1 month</button></div>` : ''}
        ${o.discount.eligible && o.discount.offer ? `<div class="alt" style="margin-top:8px"><div><b>${o.discount.offer.percent}% off for ${o.discount.offer.months} months</b><div class="small muted">${money(o.discount.offer.discounted_monthly_price)}/mo, then returns to ${money(o.discount.offer.reverts_to)}/mo. One-time offer.</div></div><button class="btn ghost" data-ret="discount">Accept</button></div>` : o.discount.reason ? `<div class="small muted" style="margin-top:8px">Discount offers: ${esc(o.discount.reason)}.</div>` : ''}
        <hr style="border:0;border-top:1px solid var(--fp-line);margin:16px 0">
        <div class="row between"><select id="reason" style="padding:8px;border-radius:8px;border:1px solid var(--fp-line);font:inherit">
          <option value="too_expensive">It's too expensive</option><option value="not_using">I don't use it enough</option><option value="found_alternative">Found an alternative</option><option value="other">Other</option></select>
          <button class="link" data-ret="cancel" style="color:#b42318">Cancel my subscription</button></div>
        <div id="ret-msg"></div>
      `);
      box.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', () => this.openCheckout(b.dataset.switch, 'retention')));
      box.querySelectorAll('[data-ret]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const out = await this.api('POST', '/retention/accept', { action: b.dataset.ret, months: 1, reason: box.querySelector('#reason').value });
          const msg = { pause: `Paused until ${out.paused_until}.`, discount: `Discount applied until ${out.discount?.until}.`, cancel: 'Your subscription has been cancelled. We\'re sorry to see you go.' }[b.dataset.ret];
          this.modal(`<div style="text-align:center"><h2>${b.dataset.ret === 'cancel' ? 'Cancelled' : 'Done'}</h2><p class="muted">${esc(msg)}</p><button class="btn" id="done">Close</button></div>`);
          this.root.getElementById('done').onclick = () => this.closeModal();
          if (b.dataset.ret === 'cancel') this.dispatchEvent(new CustomEvent('flexprice:cancelled', { bubbles: true, composed: true }));
          this.refresh();
        } catch (err) {
          b.disabled = false;
          box.querySelector('#ret-msg').innerHTML = `<div class="notice">${esc(err.message)}</div>`;
        }
      }));
    }

    // ------------------------------------------------------------------ live usage meter
    async loadMeter() {
      if (!this.token) return;
      try { this.meter = await this.api('GET', '/usage/current'); } catch { this.meter = null; }
      this.renderMeter();
    }

    renderMeter() {
      const el = this.root.getElementById('meter');
      const m = this.meter;
      if (el && m && !m.metered && m.subscription) {
        const s = m.subscription;
        el.innerHTML = `<div class="panel meter"><div class="row between"><h3 style="margin:0">Your plan</h3><span class="small muted">Billed by FlexPrice via PayPal</span></div>
          <div class="small" style="margin-top:6px">${s.status === 'active' ? (s.auto_renew ? `Renews on <b>${new Date(s.current_period_end).toLocaleDateString()}</b> for ${money(s.renewal_amount)}` : `Ends on ${new Date(s.current_period_end).toLocaleDateString()}`) : `Status: <b>${esc(s.status)}</b>`}${s.credit_balance > 0 ? ` · account credit ${money(s.credit_balance)} (used first)` : ''}</div>
          ${m.invoices.filter((i) => i.status === 'past_due').map((i) => `<div class="alt" style="margin-top:10px"><div><b>${esc(i.kind === 'renewal' ? 'Renewal' : 'Invoice')} ${esc(i.period)}</b><div class="small muted">Automatic charge failed — please pay manually</div></div><button class="btn" data-inv="${esc(i.id)}">Pay ${money(i.amount)}</button></div>`).join('')}
          <div class="small muted" style="margin-top:8px">${m.payment_method ? 'Renewals are charged to your saved PayPal account · <button class="link small" data-act="rm-pm">Remove saved account</button>' : 'No saved payment method.'}</div></div>`;
        el.querySelectorAll('[data-inv]').forEach((b) => b.addEventListener('click', () => this.payInvoice(b.dataset.inv)));
        el.querySelector('[data-act="rm-pm"]')?.addEventListener('click', async () => { if (confirm('Remove your saved PayPal account? Renewals will need manual payment.')) { await this.api('DELETE', '/payment-method'); this.loadMeter(); } });
        return;
      }
      if (!el || !m || !m.metered) { if (el) el.innerHTML = ''; return; }
      const cap = m.cap;
      const pct = cap?.applies && cap.usage_at_cap ? Math.min(100, (m.usage / cap.usage_at_cap) * 100) : 0;
      const open = m.invoices.filter((i) => i.status === 'open' || i.status === 'past_due');
      el.innerHTML = `<div class="panel meter">
        <div class="row between"><h3 style="margin:0">This month (${esc(m.period)})</h3><span class="small muted">Live metered usage</span></div>
        <div class="row" style="gap:24px;margin-top:6px"><div><div class="usage-val">${num(m.usage)}</div><div class="small muted">${esc(this.config.usage?.unit)}</div></div>
          <div><div class="usage-val">${money(m.charge_so_far)}</div><div class="small muted">charges so far</div></div></div>
        ${cap?.applies ? `<div class="bar" style="height:10px;margin-top:10px"><i style="width:${pct}%;opacity:1;background:${cap.reached ? '#b54708' : 'var(--fp-primary)'}"></i></div>
          <div class="small muted">${cap.reached ? esc(cap.message) : `${num(cap.remaining_usage_before_cap)} ${esc(this.config.usage?.unit)} until the ${money(cap.spending_cap)} cap`}</div>` : ''}
        ${open.map((i) => `<div class="alt" style="margin-top:10px"><div><b>Invoice ${esc(i.period)}</b><div class="small muted">${i.lines.map((l) => `${esc(l.description)}: ${money(l.amount)}`).join(' · ')}${i.cap_applied ? ' · cap applied' : ''}<br>${i.collection === 'automatic' ? `Will be charged to your saved PayPal on ${new Date(i.next_retry_at ?? i.charge_scheduled_at).toLocaleDateString()}` : i.status === 'past_due' ? 'Automatic charge failed — please pay manually' : 'Awaiting payment'}</div></div><button class="btn ${i.collection === 'automatic' ? 'ghost' : ''}" data-inv="${esc(i.id)}">${i.collection === 'automatic' ? 'Pay now' : 'Pay'} ${money(i.amount)}</button></div>`).join('')}
        ${m.invoices.filter((i) => i.status === 'paid').slice(-3).map((i) => `<div class="small muted" style="margin-top:6px">✓ ${esc(i.period)} invoice ${money(i.amount)} paid</div>`).join('')}
        <div class="small muted" style="margin-top:10px">${m.payment_method ? `Usage is billed to your saved PayPal account · <button class="link small" data-act="rm-pm">Remove saved account</button>` : 'No saved payment method — invoices must be paid manually.'}</div>
      </div>`;
      el.querySelectorAll('[data-inv]').forEach((b) => b.addEventListener('click', () => this.payInvoice(b.dataset.inv)));
      el.querySelector('[data-act="rm-pm"]')?.addEventListener('click', async () => {
        if (!confirm('Remove your saved PayPal account? Future usage invoices will need to be paid manually.')) return;
        await this.api('DELETE', '/payment-method');
        this.loadMeter();
      });
    }

    async payInvoice(id) {
      const inv = this.meter.invoices.find((i) => i.id === id);
      this.pending = { invoice: id };
      this.modal(`<h2>Pay invoice ${esc(inv.period)}</h2><table class="terms">${inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${money(l.amount)}</td></tr>`).join('')}<tr><td><b>Total</b></td><td><b>${money(inv.amount)}</b>${inv.cap_applied ? ' (spending cap applied)' : ''}</td></tr></table><div id="pay"><div class="muted"><span class="spin"></span> Creating PayPal order…</div></div><div id="pay-msg"></div>`);
      try {
        const co = await this.api('POST', `/invoices/${encodeURIComponent(id)}/pay`);
        this.pending.checkout = co;
        this.root.getElementById('pay').innerHTML = this.config.paypal.mode === 'simulator' ? `<iframe class="pp" src="${esc(co.approve_url)}" title="PayPal checkout"></iframe>` : `<a class="pp-btn" style="display:block;text-align:center;text-decoration:none" href="${esc(co.approve_url)}" target="_blank" rel="noopener">Pay<span>Pal</span></a>`;
      } catch (err) {
        this.payMsg(esc(err.message));
      }
    }
  }

  if (!customElements.get('flexprice-advisor')) customElements.define('flexprice-advisor', FlexPriceAdvisor);
})();
