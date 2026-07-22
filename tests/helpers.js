const prisma = require('../lib/prisma');

// Deletes all rows between tests so each test starts from a clean slate.
// Order matters because of foreign key constraints.
async function resetDatabase() {
  await prisma.captionTrack.deleteMany();
  await prisma.mediaAsset.deleteMany();
  await prisma.project.deleteMany();
  await prisma.page.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.user.deleteMany();
  await prisma.client.deleteMany();
}

module.exports = { resetDatabase };
