const clusterStorage = require('../lib/clusterStorage');
const storageCleanup = require('../lib/storageCleanup');
const { createSafeRouter } = require('../lib/safeRouter');

// Quadro de armazenamento do cluster e "Limpar armazenamento" — montado em
// routes/admin.js DEPOIS de requireAdmin e requirePrimary (só o
// administrador principal; conta restrita recebe 403 sem nenhum dado).
const router = createSafeRouter();

function fail(res, err) {
  if (err && err.status) return res.status(err.status).json({ success: false, message: err.message });
  throw err;
}

router.get('/cluster', async (req, res) => {
  const storage = await clusterStorage.getClusterStorage({ force: req.query.refresh === '1' });
  res.json({ success: true, storage });
});

router.post('/cleanup/preview', async (req, res) => {
  try {
    const preview = await storageCleanup.createPreview({ days: (req.body || {}).days, admin: req.adminUser });
    res.json({ success: true, preview });
  } catch (err) { fail(res, err); }
});

router.post('/cleanup/execute', async (req, res) => {
  const { previewId, cutoff } = req.body || {};
  try {
    const { run, promise } = await storageCleanup.startCleanup({ previewId, cutoff, admin: req.adminUser, ip: req.ip });
    // Roda em segundo plano, em lotes; o painel acompanha pelo GET abaixo.
    promise.catch((err) => console.error('[limpeza] falhou:', err && err.message));
    res.status(202).json({ success: true, run });
  } catch (err) { fail(res, err); }
});

router.get('/cleanup/current', async (req, res) => {
  res.json({ success: true, run: await storageCleanup.currentRun(), history: await storageCleanup.history(5) });
});

router.get('/cleanup/runs/:id', async (req, res) => {
  const run = await storageCleanup.getRun(req.params.id);
  if (!run || run.status === 'preview') return res.status(404).json({ success: false, message: 'Execução não encontrada.' });
  res.json({ success: true, run });
});

module.exports = router;
