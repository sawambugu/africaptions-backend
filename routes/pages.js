// CMS: marketing site pages/posts (e.g. homepage sections, blog posts).
// Reading published pages is public (the website frontend fetches these).
// Creating/editing/deleting is staff-only — this is not part of the paid
// client tier, it's how Africaptions staff manage their own site content.

const express = require('express');
const prisma = require('../lib/prisma');
const authenticate = require('../middleware/authenticate');
const requireRole = require('../middleware/requireRole');

const router = express.Router();
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

router.get('/', async (_req, res) => {
  const pages = await prisma.page.findMany({
    where: { published: true },
    orderBy: { updatedAt: 'desc' },
  });
  res.json({ pages });
});

router.get('/:slug', async (req, res) => {
  const page = await prisma.page.findUnique({ where: { slug: req.params.slug } });
  if (!page || !page.published) {
    return res.status(404).json({ error: 'Page not found.' });
  }
  res.json({ page });
});

router.post('/', authenticate, requireRole('ADMIN'), async (req, res) => {
  const { slug, title, body, published } = req.body || {};
  if (!slug || !title || !body) {
    return res.status(400).json({ error: 'slug, title and body are required.' });
  }
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: 'slug must be lowercase letters, numbers and hyphens only.' });
  }

  const existing = await prisma.page.findUnique({ where: { slug } });
  if (existing) {
    return res.status(409).json({ error: 'A page with that slug already exists.' });
  }

  const page = await prisma.page.create({ data: { slug, title, body, published: !!published } });
  res.status(201).json({ page });
});

router.patch('/:id', authenticate, requireRole('ADMIN'), async (req, res) => {
  const { title, body, published } = req.body || {};
  const existing = await prisma.page.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Page not found.' });
  }

  const page = await prisma.page.update({
    where: { id: req.params.id },
    data: {
      ...(title !== undefined && { title }),
      ...(body !== undefined && { body }),
      ...(published !== undefined && { published }),
    },
  });
  res.json({ page });
});

router.delete('/:id', authenticate, requireRole('ADMIN'), async (req, res) => {
  const existing = await prisma.page.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Page not found.' });
  }
  await prisma.page.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

module.exports = router;
