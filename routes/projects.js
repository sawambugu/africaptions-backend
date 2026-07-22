// CMS: captioning projects. Every route here requires authentication +
// the Advanced (Tier 2) plan — this is the paid CMS feature clients are
// unlocking. Staff (ADMIN) always have access, for delivering client work.

const express = require('express');
const prisma = require('../lib/prisma');
const authenticate = require('../middleware/authenticate');
const requireTier = require('../middleware/requireTier');
const { getOwnedProject } = require('../lib/projectAccess');
const mediaRouter = require('./media');
const captionsRouter = require('./captions');

const router = express.Router();

router.use(authenticate, requireTier('ADVANCED'));

const PROJECT_STATUSES = ['DRAFT', 'IN_PROGRESS', 'REVIEW', 'DELIVERED', 'ARCHIVED'];

router.get('/', async (req, res) => {
  const where = req.user.role === 'ADMIN' ? {} : { clientId: req.user.clientId };
  const projects = await prisma.project.findMany({ where, orderBy: { createdAt: 'desc' } });
  res.json({ projects });
});

router.post('/', async (req, res) => {
  const { title, notes } = req.body || {};
  if (!title) {
    return res.status(400).json({ error: 'title is required.' });
  }

  const clientId = req.user.role === 'ADMIN' ? req.body.clientId : req.user.clientId;
  if (!clientId) {
    return res.status(400).json({ error: 'clientId is required.' });
  }

  const project = await prisma.project.create({ data: { title, notes, clientId } });
  res.status(201).json({ project });
});

router.get('/:projectId', async (req, res) => {
  const project = await getOwnedProject(req, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  res.json({ project });
});

router.patch('/:projectId', async (req, res) => {
  const project = await getOwnedProject(req, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const { title, notes, status } = req.body || {};
  if (status && !PROJECT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${PROJECT_STATUSES.join(', ')}` });
  }

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: {
      ...(title !== undefined && { title }),
      ...(notes !== undefined && { notes }),
      ...(status !== undefined && { status }),
    },
  });
  res.json({ project: updated });
});

router.delete('/:projectId', async (req, res) => {
  const project = await getOwnedProject(req, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  await prisma.project.delete({ where: { id: project.id } });
  res.status(204).end();
});

router.use('/:projectId/media', mediaRouter);
router.use('/:projectId/captions', captionsRouter);

module.exports = router;
