import multer from 'multer';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

function fileFilter(_req, file, cb) {
  if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
  cb(new Error('Formato no soportado. Usá jpeg, png o webp'));
}

function wrap(multerMiddleware) {
  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'La imagen excede el tamaño máximo permitido' });
      }
      res.status(400).json({ error: err.message ?? 'Error al subir la imagen' });
    });
  };
}

export const uploadAvatar = wrap(
  multer({
    storage:    multer.memoryStorage(),
    limits:     { fileSize: 5 * 1024 * 1024 },
    fileFilter,
  }).single('image')
);

export const uploadTournamentPhoto = wrap(
  multer({
    storage:    multer.memoryStorage(),
    limits:     { fileSize: 10 * 1024 * 1024 },
    fileFilter,
  }).single('image')
);

export const uploadClubPhoto = wrap(
  multer({
    storage:    multer.memoryStorage(),
    limits:     { fileSize: 10 * 1024 * 1024 },
    fileFilter,
  }).single('image')
);

// Cabecera del club: carga a ancho completo, por eso el techo es de 4MB
export const uploadClubHeader = wrap(
  multer({
    storage:    multer.memoryStorage(),
    limits:     { fileSize: 4 * 1024 * 1024 },
    fileFilter,
  }).single('image')
);

// Reclamo de club: 3 fotos obligatorias (frente, vínculo con el lugar, red social)
export const uploadClubClaimPhotos = wrap(
  multer({
    storage:    multer.memoryStorage(),
    limits:     { fileSize: 10 * 1024 * 1024 },
    fileFilter,
  }).fields([
    { name: 'photo_front',  maxCount: 1 },
    { name: 'photo_proof',  maxCount: 1 },
    { name: 'photo_social', maxCount: 1 },
  ])
);
