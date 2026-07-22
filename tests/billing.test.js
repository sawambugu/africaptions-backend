const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const prisma = require('../lib/prisma');
const { signToken } = require('../lib/auth');
const { resetDatabase } = require('./helpers');

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

async function createClientUser({ tier, tierExpiresAt = null }) {
  const client = await prisma.client.create({ data: { name: 'Studio Co', tier, tierExpiresAt } });
  const user = await prisma.user.create({
    data: {
      email: `user-${Date.now()}-${Math.random()}@studio.com`,
      passwordHash: await bcrypt.hash('irrelevant123', 4),
      role: 'CLIENT',
      clientId: client.id,
    },
  });
  return { client, user, token: signToken(user) };
}

describe('GET /api/billing/plan', () => {
  it('is public and returns plan config', async () => {
    const res = await request(app).get('/api/billing/plan');
    expect(res.status).toBe(200);
    expect(typeof res.body.planDays).toBe('number');
    expect(typeof res.body.priceKes).toBe('number');
  });
});

describe('Advanced tier expiry', () => {
  it('grants CMS access while tierExpiresAt is in the future', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { token } = await createClientUser({ tier: 'ADVANCED', tierExpiresAt: future });

    const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('lazily downgrades and denies access once tierExpiresAt has passed', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { client, token } = await createClientUser({ tier: 'ADVANCED', tierExpiresAt: past });

    const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);

    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    expect(updated.tier).toBe('FREE');
    expect(updated.tierExpiresAt).toBeNull();
  });

  it('never expires when tierExpiresAt is null', async () => {
    const { token } = await createClientUser({ tier: 'ADVANCED', tierExpiresAt: null });
    const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('Payment initiation without provider credentials configured', () => {
  it('POST /api/billing/paystack/initialize fails gracefully (502), not a crash', async () => {
    const { token } = await createClientUser({ tier: 'FREE' });
    const res = await request(app)
      .post('/api/billing/paystack/initialize')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(502);
  });

  it('POST /api/billing/mpesa/stk-push fails gracefully (502), not a crash', async () => {
    const { token } = await createClientUser({ tier: 'FREE' });
    const res = await request(app)
      .post('/api/billing/mpesa/stk-push')
      .set('Authorization', `Bearer ${token}`)
      .send({ phoneNumber: '0712345678' });
    expect(res.status).toBe(502);
  });
});

describe('GET /api/billing/status/:reference', () => {
  it("only exposes a payment to its owning client", async () => {
    const owner = await createClientUser({ tier: 'FREE' });
    const other = await createClientUser({ tier: 'FREE' });

    const intent = await prisma.paymentIntent.create({
      data: {
        provider: 'MPESA',
        reference: 'ws_CO_test_ref_1',
        planDays: 30,
        amount: 2000,
        clientId: owner.client.id,
      },
    });

    const ownRes = await request(app)
      .get(`/api/billing/status/${intent.reference}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(ownRes.status).toBe(200);
    expect(ownRes.body.status).toBe('PENDING');

    const otherRes = await request(app)
      .get(`/api/billing/status/${intent.reference}`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(otherRes.status).toBe(404);
  });
});

describe('Admin manual tier grant', () => {
  async function createAdmin() {
    const user = await prisma.user.create({
      data: {
        email: `admin-${Date.now()}@africaptions.com`,
        passwordHash: await bcrypt.hash('irrelevant123', 4),
        role: 'ADMIN',
      },
    });
    return { user, token: signToken(user) };
  }

  it('lets an admin grant ADVANCED tier to a client', async () => {
    const { client } = await createClientUser({ tier: 'FREE' });
    const admin = await createAdmin();

    const res = await request(app)
      .patch(`/api/admin/clients/${client.id}/tier`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ tier: 'ADVANCED', tierExpiresAt: null });

    expect(res.status).toBe(200);
    expect(res.body.client.tier).toBe('ADVANCED');
  });

  it('rejects a non-admin trying to grant a tier', async () => {
    const { client, token } = await createClientUser({ tier: 'FREE' });
    const res = await request(app)
      .patch(`/api/admin/clients/${client.id}/tier`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'ADVANCED' });
    expect(res.status).toBe(403);
  });
});
