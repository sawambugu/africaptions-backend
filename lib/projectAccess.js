const prisma = require('./prisma');

// Loads a project and enforces that it belongs to the requesting user's
// client account — unless the user is staff (ADMIN), who can reach any
// client's project. Returns null (and does not respond) if not found/owned;
// callers should 404 in that case.
async function getOwnedProject(req, projectId) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return null;
  if (req.user.role !== 'ADMIN' && project.clientId !== req.user.clientId) return null;
  return project;
}

module.exports = { getOwnedProject };
