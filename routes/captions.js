// CMS: caption/subtitle tracks attached to a project. Mounted at
// /api/projects/:projectId/captions by routes/projects.js.

const express = require('express');
const prisma = require('../lib/prisma');
const { saveFile } = require('../lib/storage');
const { getOwnedProject } = require('../lib/projectAccess');

const router = express.Router({ mergeParams: true });

const CAPTION_FORMATS = ['SRT', 'VTT', 'SCC', 'TXT'];

router.get('/', async (req, res) => {
  const project = await getOwnedProject(req, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const captionTracks = await prisma.captionTrack.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ captionTracks });
});

router.post('/', async (req, res) => {
  const project = await getOwnedProject(req, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const { language, format, content } = req.body || {};
  if (!language || !format || !content) {
    return res.status(400).json({ error: 'language, format and content are required.' });
  }
  if (!CAPTION_FORMATS.includes(format)) {
    return res.status(400).json({ error: `format must be one of: ${CAPTION_FORMATS.join(', ')}` });
  }

  const fileUrl = await saveFile({
    buffer: Buffer.from(content, 'utf8'),
    originalName: `${language}.${format.toLowerCase()}`,
    mimeType: 'text/plain',
  });

  const track = await prisma.captionTrack.create({
    data: { projectId: project.id, language, format, fileUrl },
  });
  res.status(201).json({ captionTrack: track });
});

router.delete('/:captionId', async (req, res) => {
  const project = await getOwnedProject(req, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const track = await prisma.captionTrack.findUnique({ where: { id: req.params.captionId } });
  if (!track || track.projectId !== project.id) {
    return res.status(404).json({ error: 'Caption track not found.' });
  }

  await prisma.captionTrack.delete({ where: { id: track.id } });
  res.status(204).end();
});

module.exports = router;
