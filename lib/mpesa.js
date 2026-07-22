// Thin wrapper around Safaricom's Daraja API for M-Pesa STK Push
// (Lipa Na M-Pesa Online). Uses Node's built-in fetch (Node 22+).

const MPESA_ENV = process.env.MPESA_ENV === 'production' ? 'production' : 'sandbox';
const BASE_URL =
  MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

function timestampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

async function getAccessToken() {
  const consumerKey = requireEnv('MPESA_CONSUMER_KEY');
  const consumerSecret = requireEnv('MPESA_CONSUMER_SECRET');
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const res = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`M-Pesa OAuth failed: ${body.errorMessage || res.statusText}`);
  }
  return body.access_token;
}

// Normalizes a Kenyan phone number to the 2547XXXXXXXX format Daraja expects.
function normalizePhoneNumber(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.startsWith('7') || digits.startsWith('1')) return `254${digits}`;
  throw new Error('Invalid Kenyan phone number. Use format 07XXXXXXXX or 2547XXXXXXXX.');
}

async function stkPush({ phoneNumber, amountKes, accountReference, callbackUrl }) {
  const shortCode = requireEnv('MPESA_SHORTCODE');
  const passkey = requireEnv('MPESA_PASSKEY');
  const timestamp = timestampNow();
  const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
  const phone = normalizePhoneNumber(phoneNumber);

  const accessToken = await getAccessToken();

  const res = await fetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amountKes),
      PartyA: phone,
      PartyB: shortCode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: accountReference.slice(0, 12),
      TransactionDesc: 'Africaptions Advanced plan',
    }),
  });

  const body = await res.json();
  if (!res.ok || body.ResponseCode !== '0') {
    throw new Error(`M-Pesa STK push failed: ${body.errorMessage || body.ResponseDescription || res.statusText}`);
  }
  return body; // { MerchantRequestID, CheckoutRequestID, ResponseCode, CustomerMessage }
}

module.exports = { stkPush, normalizePhoneNumber };
