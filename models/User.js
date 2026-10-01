const { mongoose } = require('../config/db');

// Perfis do painel: "primary" (administrador principal, acesso completo) e
// "restricted" (administrador restrito: sem Logins/senhas, Segurança &
// auditoria, Integração BotGhost e Mensagens do Bot). "admin" é o valor
// antigo, gravado antes dos perfis existirem: vale como principal e é
// convertido por migrateAdminRoles() no início do site.
const ROLES = ['primary', 'restricted', 'admin'];

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ROLES, default: 'restricted' },
  displayName: { type: String, default: null, trim: true },
  active: { type: Boolean, default: true },
  // Sobe a cada desativação/troca de senha: toda sessão aberta com o número
  // antigo deixa de valer no próximo pedido (requireAdmin) e nos sockets.
  sessionVersion: { type: Number, default: 0 },
  createdBy: { type: String, default: null },
  passwordChangedAt: { type: Date, default: null },
  lastLoginAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
