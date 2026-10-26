-- Un blob gzip por dataset (particionado si supera el tope de un bind de D1).
-- La fila vigente está en dataset_heads. Las generaciones viejas se borran
-- después de publicar la nueva, así un corte no deja el dataset a medias.

CREATE TABLE IF NOT EXISTS dataset_heads (
  key TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  parts INTEGER NOT NULL,
  raw_bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_parts (
  key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  part INTEGER NOT NULL,
  gzip BLOB NOT NULL,
  PRIMARY KEY (key, generation, part)
);

CREATE INDEX IF NOT EXISTS dataset_parts_key ON dataset_parts (key, generation, part);
