// Single shared Prisma Client instance, reused across the app so we don't
// exhaust the database connection pool (especially important with
// nodemon/hot-reload in dev, which would otherwise create a new client
// on every reload).

const { PrismaClient } = require('@prisma/client');

const prisma = global.__prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

module.exports = prisma;
