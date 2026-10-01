const adminUsers = require('../lib/adminUsers');
const { logSecurityEvent } = require('../lib/securityLog');
const { createSafeRouter } = require('../lib/safeRouter');

// Logins/senhas — montado em routes/admin.js DEPOIS de requireAdmin e
// requirePrimary: só o administrador principal chega aqui. Contas criadas
// aqui são sempre RESTRITAS; o principal nunca é alterado por estas rotas.
// Nenhuma resposta contém senha ou hash.
const router = createSafeRouter();

function actor(req) {
  return `admin:${req.adminUser.username}`;
}

function fail(res, err) {
  if (err && err.status) return res.status(err.status).json({ success: false, message: err.message });
  throw err;
}

router.get('/', async (req, res) => {
  res.json({ success: true, users: await adminUsers.listUsers() });
});

router.post('/', async (req, res) => {
  const { displayName, username, password } = req.body || {};
  try {
    const user = await adminUsers.createRestrictedUser({ displayName, username, password }, actor(req));
    await logSecurityEvent('admin_user_created', { meta: { userId: user.id, username: user.username, role: user.role, by: actor(req) }, ip: req.ip });
    res.status(201).json({ success: true, user });
  } catch (err) { fail(res, err); }
});

router.put('/:id', async (req, res) => {
  try {
    const user = await adminUsers.updateRestrictedUser(req.params.id, req.body || {});
    await logSecurityEvent('admin_user_updated', { meta: { userId: user.id, username: user.username, by: actor(req) }, ip: req.ip });
    res.json({ success: true, user });
  } catch (err) { fail(res, err); }
});

router.post('/:id/password', async (req, res) => {
  try {
    const user = await adminUsers.resetRestrictedPassword(req.params.id, (req.body || {}).password);
    adminUsers.disconnectAdminSockets(req.app.get('io'), user.id);
    await logSecurityEvent('admin_user_password_reset', { meta: { userId: user.id, username: user.username, by: actor(req) }, ip: req.ip });
    res.json({ success: true, user });
  } catch (err) { fail(res, err); }
});

router.post('/:id/active', async (req, res) => {
  try {
    const active = Boolean((req.body || {}).active);
    const user = await adminUsers.setRestrictedActive(req.params.id, active);
    if (!active) adminUsers.disconnectAdminSockets(req.app.get('io'), user.id);
    await logSecurityEvent(active ? 'admin_user_activated' : 'admin_user_deactivated', { meta: { userId: user.id, username: user.username, by: actor(req) }, ip: req.ip });
    res.json({ success: true, user });
  } catch (err) { fail(res, err); }
});

module.exports = router;
