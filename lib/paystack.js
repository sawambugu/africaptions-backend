// Thin wrapper around the Paystack REST API. Uses Node's built-in fetch
// (Node 22+) so no extra HTTP client dependency is needed.

const crypto = require('crypto');

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function getSecretKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error('PAYSTACK_SECRET_KEY is not set.');
  return key;
}

// Paystack expects amounts in the currency's smallest unit (e.g. cents for
// KES/NGN/GHS/ZAR), same convention as Stripe.
function toSubunit(amountInWholeUnits) {
  return Math.round(amountInWholeUnits * 100);
}

async function initializeTransaction({ email, amountKes, reference, callbackUrl, metadata }) {
  const res = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      amount: toSubunit(amountKes),
      currency: 'KES',
      reference,
      callback_url: callbackUrl,
      metadata,
    }),
  });

  const body = await res.json();
  if (!res.ok || !body.status) {
    throw new Error(`Paystack initialize failed: ${body.message || res.statusText}`);
  }
  return body.data; // { authorization_url, access_code, reference }
}

// Paystack signs webhook bodies with HMAC-SHA512 of the RAW request body,
// using your secret key. rawBody must be the untouched Buffer/string as
// received — do not pass a re-serialized/parsed-then-stringified object.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha512', getSecretKey()).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

module.exports = { initializeTransaction, verifyWebhookSignature };
