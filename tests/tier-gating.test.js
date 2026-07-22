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

async function createClientUser({ tier }) {
  const client = await prisma.client.create({ data: { name: 'Studio Co', tier } });
  const user = await prisma.user.create({
    data: {
      email: `${tier.toLowerCase()}-${Date.now()}@studio.com`,
      passwordHash: await bcrypt.hash('irrelevant123', 4),
      role: 'CLIENT',
      clientId: client.id,
    },
  });
  return { client, user, token: signToken(user) };
}

async function createAdminUser() {
  const user = await prisma.user.create({
    data: {
      email: `admin-${Date.now()}@africaptions.com`,
      passwordHash: await bcrypt.hash('irrelevant123', 4),
      role: 'ADMIN',
    },
  });
  return { user, token: signToken(user) };
}

describe('CMS access is gated behind the Advanced (Tier 2) plan', () => {
  it('blocks a FREE-tier client from the CMS', async () => {
    const { token } = await createClientUser({ tier: 'FREE' });
    const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.currentTier).toBe('FREE');
  });

  it('blocks a STANDARD-tier client from the CMS', async () => {
    const { token } = await createClientUser({ tier: 'STANDARD' });
    const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('allows an ADVANCED-tier client into the CMS', async () => {
    const { token } = await createClientUser({ tier: 'ADVANCED' });
    const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });

  it('lets an ADVANCED client create and only see their own projects', async () => {
    const clientA = await createClientUser({ tier: 'ADVANCED' });
    const clientB = await createClientUser({ tier: 'ADVANCED' });

    const create = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${clientA.token}`)
      .send({ title: 'Documentary captions' });
    expect(create.status).toBe(201);

    const listA = await request(app).get('/api/projects').set('Authorization', `Bearer ${clientA.token}`);
    expect(listA.body.projects).toHaveLength(1);

    const listB = await request(app).get('/api/projects').set('Authorization', `Bearer ${clientB.token}`);
    expect(listB.body.projects).toHaveLength(0);

    const getFromB = await request(app)
      .get(`/api/projects/${create.body.project.id}`)
      .set('Authorization', `Bearer ${clientB.token}`);
    expect(getFromB.status).toBe(404);
  });

  it('lets staff (ADMIN) bypass the tier check entirely', async () => {
    const { token } = await createAdminUser();
    const res = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('rejects requests with no auth token', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
  });

  it('rejects requests with a tampered token', async () => {
    const res = await request(app).get('/api/projects').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});
