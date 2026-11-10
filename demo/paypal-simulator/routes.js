// DEMO ONLY — buyer-facing approval pages for the PayPal simulator.

import express from 'express';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = (body, script) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PayPal Checkout (Simulator)</title>
<style>
body{margin:0;font-family:-apple-system,Helvetica,Arial,sans-serif;background:#f5f7fa;color:#001c64}
.top{background:#fff;border-bottom:1px solid #e3e7ee;padding:14px 22px;display:flex;justify-content:space-between;align-items:center}
.logo{font-weight:800;font-size:22px;font-style:italic}.logo b{color:#003087}.logo span{color:#009cde}
.badge{font-size:11px;background:#fff4ce;color:#7a5b00;border-radius:10px;padding:3px 8px}
.card{max-width:420px;margin:24px auto;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);padding:24px}
.amt{font-size:30px;font-weight:700;margin:6px 0 2px}.muted{color:#6c7378;font-size:13px}
.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #eef1f5;font-size:14px}
button{width:100%;border:0;border-radius:24px;padding:13px;font-size:16px;font-weight:700;cursor:pointer;margin-top:12px}
.pay{background:#0070e0;color:#fff}.pay:hover{background:#003087}.alt{background:#eef1f5;color:#001c64}.decline{background:none;color:#a00;font-size:13px;font-weight:500}
</style></head><body>
<div class="top"><div class="logo"><b>Pay</b><span>Pal</span></div><span class="badge">SANDBOX SIMULATOR</span></div>
<div class="card">${body}</div><script>${script}</script></body></html>`;

export function paypalSimRouter(sim) {
  const r = express.Router();
  r.get('/checkout', async (req, res, next) => {
    if (!req.query.setup_token) return next();
    const st = sim.getSetupToken(String(req.query.setup_token));
    if (!st) return res.status(404).send('Setup token not found');
    res.type('html').send(page(`
      <div class="muted">Save PayPal for future payments</div>
      <div class="amt" style="font-size:22px">No payment today</div>
      <div class="muted">The merchant will be able to charge this account for usage after each billing month, within the limits you accepted. You can remove it at any time.</div>
      <div style="margin-top:16px"><div class="row"><span>Account</span><b>PayPal Balance •••• 4242</b></div><div class="row"><span>Setup token</span><span>${esc(st.id)}</span></div></div>
      <button class="pay" onclick="act('approve')">Agree and Save</button>
      <button class="alt" onclick="act('cancel')">Cancel and return to merchant</button>`,
      `async function act(kind){const id=${JSON.stringify(st.id)};
        if(kind==='approve'){await fetch('/paypal-sim/approve-setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:id})});}
        window.parent.postMessage({source:'paypal-sim',type:kind==='approve'?'approved':'cancelled',setupTokenID:id},'*');}`));
  });
  r.post('/approve-setup', express.json(), (req, res) => {
    try {
      res.json(sim.approveSetupToken(String(req.body.token)));
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  r.get('/checkout', async (req, res) => {
    const order = await sim.getOrder(String(req.query.token)).catch(() => null);
    if (!order) return res.status(404).send('Order not found');
    const pu = order.purchase_units[0];
    res.type('html').send(page(`
  <div class="muted">Pay ${esc(pu.description?.split(' — ')[0])}</div>
  <div class="amt">${esc(pu.amount.value)} ${esc(pu.amount.currency_code)}</div>
  <div class="muted">${esc(pu.description)}</div>
  <div style="margin-top:16px">
    <div class="row"><span>Pay with</span><b>PayPal Balance •••• 4242</b></div>
    <div class="row"><span>Buyer</span><span>sandbox-buyer@example.com</span></div>
    <div class="row"><span>Order ID</span><span>${esc(order.id)}</span></div>
  </div>
  <button class="pay" onclick="act('approve')">Complete Purchase</button>
  <button class="alt" onclick="act('cancel')">Cancel and return to merchant</button>
  <button class="decline" onclick="act('decline')">Simulate a declined card</button>
`, `
async function act(kind){
  const id=${JSON.stringify(order.id)};
  if(kind!=='cancel'){await fetch('/paypal-sim/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:id,decline:kind==='decline'})});}
  const msg={source:'paypal-sim',type:kind==='cancel'?'cancelled':'approved',orderID:id};
  if(window.parent!==window) window.parent.postMessage(msg,'*'); else location.href='/demo/return.html?token='+id+(kind==='cancel'?'&cancelled=1':'');
}
`));
  });
  r.post('/approve', express.json(), (req, res) => {
    try {
      const o = sim.approve(String(req.body.token), { decline: req.body.decline });
      res.json({ id: o.id, status: o.status });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });
  return r;
}
