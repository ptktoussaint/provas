const Settings = require('../models/Settings');
const { createSafeRouter } = require('../lib/safeRouter');

const router = createSafeRouter();

// Endpoint público (sem sessão) — a identidade visual precisa estar
// disponível antes de qualquer login/identificação, tanto no painel admin
// quanto nas telas de aluno e fiscal.
router.get('/', async (req, res) => {
  const settings = await Settings.getOrCreate();
  res.json({
    success: true,
    platformName: settings.platformName,
    logoUrl: settings.logoUrl,
    theme: settings.theme,
  });
});

module.exports = router;
