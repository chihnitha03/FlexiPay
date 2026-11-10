import express from 'express';

export function webhookRoutes({ billing }) {
  const r = express.Router();
  r.post('/paypal', async (req, res) => {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const out = await billing.handleWebhook(headers, req.body);
    res.status(out.status).json(out.body);
  });
  return r;
}
