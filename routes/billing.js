// Billing for the Advanced (Tier 2) plan via Paystack (card/mobile money
// checkout) and M-Pesa (direct STK Push). Neither rail supports true
// recurring billing on mobile money, so both providers pay for a fixed
// number of days of access (ADVANCED_PLAN_DAYS) — see PaymentIntent in
// prisma/schema.prisma and the expiry check in middleware/requireTier.js.
//
// IMPORTANT: the Paystack webhook is the only place a successful PAYSTACK
// payment upgrades a client's tier; the M-Pesa callback is the only place
// a successful MPESA payment does. Nothing else may write client.tier.

const crypto = require('crypto');
const express = require('express');
const prisma = require('../lib/prisma');
const authenticate = require('../middleware/authenticate');
const paystack = require('../lib/paystack');
const mpesa = require('../lib/mpesa');

const router = express.Router();

const PLAN_DAYS = parseInt(process.env.ADVANCED_PLAN_DAYS || '30', 10);
const PLAN_PRICE_KES = parseInt(process.env.ADVANCED_PLAN_PRICE_KES || '2000', 10);

function extendExpiry(currentExpiresAt, planDays) {
  const now = new Date();
  const base = currentExpiresAt && currentExpiresAt > now ? currentExpiresAt : now;
  return new Date(base.getTime() + planDays * 24 * 60 * 60 * 1000);
}

async function grantAdvancedTier(paymentIntent) {
  const client = await prisma.client.findUnique({ where: { id: paymentIntent.clientId } });
  if (!client) return;
  await prisma.client.update({
    where: { id: client.id },
    data: {
      tier: 'ADVANCED',
      tierExpiresAt: extendExpiry(client.tierExpiresAt, paymentIntent.planDays),
    },
  });
}

router.get('/plan', (_req, res) => {
  res.json({ planDays: PLAN_DAYS, priceKes: PLAN_PRICE_KES });
});

// --- Paystack -------------------------------------------------------------

router.post('/paystack/initialize', authenticate, async (req, res) => {
  if (!req.user.clientId) {
    return res.status(400).json({ error: 'No client account associated with this user.' });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const reference = `ap_${crypto.randomBytes(12).toString('hex')}`;

  const intent = await prisma.paymentIntent.create({
    data: {
      provider: 'PAYSTACK',
      reference,
      planDays: PLAN_DAYS,
      amount: PLAN_PRICE_KES,
      clientId: req.user.clientId,
    },
  });

  try {
    const data = await paystack.initializeTransaction({
      email: user.email,
      amountKes: PLAN_PRICE_KES,
      reference,
      callbackUrl: `${process.env.APP_URL}/dashboard/billing-callback.html`,
      metadata: { clientId: req.user.clientId, paymentIntentId: intent.id },
    });
    res.json({ authorizationUrl: data.authorization_url, reference });
  } catch (err) {
    console.error('Paystack initialize error:', err);
    res.status(502).json({ error: 'Could not start the Paystack checkout. Please try again.' });
  }
});

// Mounted directly on `app` with express.raw() in server.js, before the
// global express.json() — Paystack's signature covers the exact raw bytes.
async function paystackWebhookHandler(req, res) {
  const signature = req.headers['x-paystack-signature'];

  if (!paystack.verifyWebhookSignature(req.body, signature)) {
    console.error('Paystack webhook signature verification failed.');
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid payload.' });
  }

  // Ack immediately; process after. Paystack retries on non-2xx, so any
  // error below should still result in a 200 once we've already applied
  // the update, to avoid duplicate side effects on retry.
  res.json({ received: true });

  if (event.event !== 'charge.success') return;

  try {
    const reference = event.data && event.data.reference;
    const intent = await prisma.paymentIntent.findUnique({ where: { reference } });
    if (!intent || intent.status !== 'PENDING') return; // unknown or already handled

    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'SUCCESS' } });
    await grantAdvancedTier(intent);
  } catch (err) {
    console.error('Error handling Paystack webhook event:', err);
  }
}

// --- M-Pesa -----------------------------------------------------------------

router.post('/mpesa/stk-push', authenticate, async (req, res) => {
  if (!req.user.clientId) {
    return res.status(400).json({ error: 'No client account associated with this user.' });
  }
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber is required, e.g. 07XXXXXXXX.' });
  }

  const callbackUrl = `${process.env.APP_URL}/api/billing/mpesa/callback?key=${encodeURIComponent(
    process.env.MPESA_CALLBACK_SECRET || ''
  )}`;

  try {
    const result = await mpesa.stkPush({
      phoneNumber,
      amountKes: PLAN_PRICE_KES,
      accountReference: req.user.clientId,
      callbackUrl,
    });

    await prisma.paymentIntent.create({
      data: {
        provider: 'MPESA',
        reference: result.CheckoutRequestID,
        planDays: PLAN_DAYS,
        amount: PLAN_PRICE_KES,
        clientId: req.user.clientId,
      },
    });

    res.json({
      reference: result.CheckoutRequestID,
      message: result.CustomerMessage || 'Check your phone to complete the M-Pesa payment.',
    });
  } catch (err) {
    console.error('M-Pesa STK push error:', err);
    res.status(502).json({ error: 'Could not start the M-Pesa payment. Please try again.' });
  }
});

// Safaricom calls this once the customer approves/cancels the STK push.
// Protected by a shared-secret query param (Daraja has no HMAC signing on
// callbacks like Stripe/Paystack do).
router.post('/mpesa/callback', async (req, res) => {
  if (req.query.key !== process.env.MPESA_CALLBACK_SECRET) {
    return res.status(401).json({ ResultCode: 1, ResultDesc: 'Unauthorized' });
  }

  // Always acknowledge Safaricom so it stops retrying, even if our
  // downstream processing hits an issue.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const callback = req.body && req.body.Body && req.body.Body.stkCallback;
    if (!callback) return;

    const intent = await prisma.paymentIntent.findUnique({
      where: { reference: callback.CheckoutRequestID },
    });
    if (!intent || intent.status !== 'PENDING') return;

    if (callback.ResultCode === 0) {
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'SUCCESS' } });
      await grantAdvancedTier(intent);
    } else {
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'FAILED' } });
    }
  } catch (err) {
    console.error('Error handling M-Pesa callback:', err);
  }
});

// --- Shared: let the frontend poll a payment's status ----------------------

router.get('/status/:reference', authenticate, async (req, res) => {
  const intent = await prisma.paymentIntent.findUnique({ where: { reference: req.params.reference } });
  if (!intent || (req.user.role !== 'ADMIN' && intent.clientId !== req.user.clientId)) {
    return res.status(404).json({ error: 'Payment not found.' });
  }
  res.json({ status: intent.status, provider: intent.provider, planDays: intent.planDays });
});

module.exports = router;
module.exports.paystackWebhookHandler = paystackWebhookHandler;
