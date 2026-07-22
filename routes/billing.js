// POST /api/billing/checkout-session — starts a Stripe Checkout flow for the
//   logged-in client to upgrade to the Advanced (Tier 2) plan.
// POST /api/billing/webhook — Stripe calls this on subscription lifecycle
//   events; this is the ONLY place a client's tier is upgraded/downgraded,
//   so the CMS can never be unlocked by a client just editing their own record.
//
// NOTE: the webhook route needs the raw request body to verify Stripe's
// signature, so it must be mounted in server.js with express.raw(),
// BEFORE the global express.json() middleware runs on it.

const express = require('express');
const Stripe = require('stripe');
const prisma = require('../lib/prisma');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set.');
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

router.post('/checkout-session', authenticate, async (req, res) => {
  if (!req.user.clientId) {
    return res.status(400).json({ error: 'No client account associated with this user.' });
  }
  if (!process.env.STRIPE_PRICE_ADVANCED) {
    return res.status(500).json({ error: 'Billing is not configured (missing STRIPE_PRICE_ADVANCED).' });
  }

  const stripe = getStripe();
  const client = await prisma.client.findUnique({ where: { id: req.user.clientId } });

  let stripeCustomerId = client.stripeCustomerId;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      metadata: { clientId: client.id },
    });
    stripeCustomerId = customer.id;
    await prisma.client.update({
      where: { id: client.id },
      data: { stripeCustomerId },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [{ price: process.env.STRIPE_PRICE_ADVANCED, quantity: 1 }],
    success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/billing/cancelled`,
    metadata: { clientId: client.id },
  });

  res.json({ url: session.url });
});

// Exported separately (not on `router`) because it must be mounted directly
// on `app` with express.raw() BEFORE the global express.json() middleware —
// see server.js. Stripe needs the untouched raw body to verify signatures.
async function webhookHandler(req, res) {
  const stripe = getStripe();
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed.` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const clientId = session.metadata && session.metadata.clientId;
        if (clientId) {
          await prisma.client.update({
            where: { id: clientId },
            data: {
              tier: 'ADVANCED',
              stripeSubscriptionId: session.subscription,
            },
          });
        }
        break;
      }
      case 'customer.subscription.deleted':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const client = await prisma.client.findUnique({
          where: { stripeSubscriptionId: subscription.id },
        });
        if (client) {
          const active = subscription.status === 'active' || subscription.status === 'trialing';
          await prisma.client.update({
            where: { id: client.id },
            data: { tier: active ? 'ADVANCED' : 'FREE' },
          });
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Error handling Stripe webhook event:', err);
    res.status(500).json({ error: 'Webhook handler failed.' });
  }
}

module.exports = router;
module.exports.webhookHandler = webhookHandler;
