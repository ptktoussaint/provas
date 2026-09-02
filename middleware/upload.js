const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Requisito #48: validar MIME + extensão, limitar tamanho, nunca usar o
// nome original do arquivo (evita path traversal / colisão / execução).
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'public', 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
    cb(null, safeName);
  },
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
    return cb(new Error('Formato de arquivo não permitido. Use PNG, JPG ou WEBP.'));
  }
  cb(null, true);
}

const uploadImage = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_SIZE_BYTES, files: 1 },
});

// Vídeo de boas-vindas/introdução, enviado como arquivo em vez de link do
// YouTube (o embed do YouTube causava erros de reprodução recorrentes).
// Limite bem mais generoso que o de imagem, mas ainda finito — sem isso um
// upload gigante podia encher o disco (que no Render é compartilhado e
// limitado) ou travar a requisição por minutos.
const VIDEO_ALLOWED_MIME = new Set(['video/mp4', 'video/webm', 'video/ogg']);
const VIDEO_ALLOWED_EXT = new Set(['.mp4', '.webm', '.ogg', '.ogv']);
const VIDEO_MAX_SIZE_BYTES = 300 * 1024 * 1024;

const videoStorage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'public', 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
    cb(null, safeName);
  },
});

function videoFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!VIDEO_ALLOWED_MIME.has(file.mimetype) || !VIDEO_ALLOWED_EXT.has(ext)) {
    return cb(new Error('Formato de vídeo não permitido. Use MP4, WEBM ou OGG.'));
  }
  cb(null, true);
}

const uploadVideo = multer({
  storage: videoStorage,
  fileFilter: videoFileFilter,
  limits: { fileSize: VIDEO_MAX_SIZE_BYTES, files: 1 },
});

module.exports = { uploadImage, uploadVideo };
