const request = require('supertest');
const app = require('../server');
const prisma = require('../lib/prisma');
const { resetDatabase } = require('./helpers');

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/auth/register', () => {
  it('creates a client + user and returns a token', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'owner@studio.com',
      password: 'supersecret1',
      clientName: 'Studio Co',
    });

    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.client.tier).toBe('FREE');
    expect(res.body.user.email).toBe('owner@studio.com');
  });

  it('rejects duplicate emails', async () => {
    await request(app).post('/api/auth/register').send({
      email: 'dupe@studio.com',
      password: 'supersecret1',
      clientName: 'Studio Co',
    });

    const res = await request(app).post('/api/auth/register').send({
      email: 'dupe@studio.com',
      password: 'anotherpass1',
      clientName: 'Studio Co 2',
    });

    expect(res.status).toBe(409);
  });

  it('rejects a short password', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'short@studio.com',
      password: 'short',
      clientName: 'Studio Co',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials', async () => {
    await request(app).post('/api/auth/register').send({
      email: 'login@studio.com',
      password: 'supersecret1',
      clientName: 'Studio Co',
    });

    const res = await request(app).post('/api/auth/login').send({
      email: 'login@studio.com',
      password: 'supersecret1',
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  it('rejects a wrong password', async () => {
    await request(app).post('/api/auth/register').send({
      email: 'wrongpass@studio.com',
      password: 'supersecret1',
      clientName: 'Studio Co',
    });

    const res = await request(app).post('/api/auth/login').send({
      email: 'wrongpass@studio.com',
      password: 'nope-nope-nope',
    });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the current user and client', async () => {
    const register = await request(app).post('/api/auth/register').send({
      email: 'me@studio.com',
      password: 'supersecret1',
      clientName: 'Studio Co',
    });

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${register.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('me@studio.com');
    expect(res.body.client.tier).toBe('FREE');
  });
});
