// CMS: media assets attached to a project. Mounted at
// /api/projects/:projectId/media by routes/projects.js (which already
// applies authenticate + requireTier('ADVANCED') to everything under it).

const express = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { saveFile } = require('../lib/storage');
const { getOwnedProject } = require('../lib/projectAccess');

const router = express.Router({ mergeParams: true });

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB — plenty for caption source video/audio
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

router.get('/', async (req, res) => {
  const project = await getOwnedProject(req, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const media = await prisma.mediaAsset.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ media });
});

router.post('/', upload.single('file'), async (req, res) => {
  const project = await getOwnedProject(req, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (!req.file) {
    return res.status(400).json({ error: 'file is required (multipart/form-data, field name "file").' });
  }

  const url = await saveFile({
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
  });

  const asset = await prisma.mediaAsset.create({
    data: {
      projectId: project.id,
      filename: req.file.originalname,
      url,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
    },
  });
  res.status(201).json({ media: asset });
});

router.delete('/:mediaId', async (req, res) => {
  const project = await getOwnedProject(req, req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const asset = await prisma.mediaAsset.findUnique({ where: { id: req.params.mediaId } });
  if (!asset || asset.projectId !== project.id) {
    return res.status(404).json({ error: 'Media asset not found.' });
  }

  await prisma.mediaAsset.delete({ where: { id: asset.id } });
  res.status(204).end();
});

module.exports = router;
