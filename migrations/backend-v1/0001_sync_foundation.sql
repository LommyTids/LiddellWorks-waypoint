-- Staging foundation. One row per trip/record; no account-wide JSON snapshot.
PRAGMA foreign_keys = ON;

CREATE TABLE sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  dataset_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  epoch INTEGER NOT NULL DEFAULT 1,
  retention_floor INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sync_state(singleton) VALUES (1);

CREATE TABLE trips (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  legacy_extras_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(legacy_extras_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE INDEX trips_owner ON trips(owner_id, deleted, id);

CREATE TABLE trip_grants (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  account_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','user','viewer')),
  companion_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(trip_id, account_id)
);
CREATE INDEX grants_account ON trip_grants(account_id, trip_id);

CREATE TABLE records (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  kind TEXT NOT NULL CHECK(kind IN ('destination','activity','transport','accommodation','companion','contact','expense')),
  id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(trip_id, kind, id)
);
CREATE INDEX records_trip_live ON records(trip_id, deleted, kind, id);

CREATE TABLE record_tags (
  trip_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  PRIMARY KEY(trip_id, kind, record_id, companion_id),
  FOREIGN KEY(trip_id,kind,record_id) REFERENCES records(trip_id,kind,id)
);
CREATE INDEX tags_companion ON record_tags(trip_id,companion_id,kind,record_id);

CREATE TABLE changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert','delete'))
);
CREATE INDEX changes_trip_sequence ON changes(trip_id,sequence);

CREATE TABLE mutation_receipts (
  account_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id,mutation_id)
);

-- A failed precondition fails the entire D1 batch, including its receipt.
CREATE TABLE write_guards (token TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE import_manifest (id INTEGER PRIMARY KEY CHECK(id=1), source_hash TEXT NOT NULL, imported_at TEXT NOT NULL);

CREATE TRIGGER trip_created AFTER INSERT ON trips BEGIN
  INSERT INTO changes(trip_id,kind,record_id,revision,operation)
  VALUES(new.id,'trip',new.id,new.revision,'upsert');
END;
CREATE TRIGGER trip_changed AFTER UPDATE ON trips BEGIN
  INSERT INTO changes(trip_id,kind,record_id,revision,operation)
  VALUES(new.id,'trip',new.id,new.revision,CASE WHEN new.deleted=1 THEN 'delete' ELSE 'upsert' END);
  UPDATE sync_state SET epoch=epoch+1 WHERE old.owner_id<>new.owner_id;
END;

CREATE TRIGGER record_created AFTER INSERT ON records BEGIN
  INSERT INTO record_tags SELECT new.trip_id,new.kind,new.id,value
    FROM json_each(new.payload_json,'$.companions') WHERE type='text' GROUP BY value;
  INSERT INTO changes(trip_id,kind,record_id,revision,operation)
    VALUES(new.trip_id,new.kind,new.id,new.revision,'upsert');
  UPDATE sync_state SET epoch=epoch+1 WHERE coalesce(json_extract(new.payload_json,'$.contactId'),'')<>'';
END;
CREATE TRIGGER record_changed AFTER UPDATE ON records BEGIN
  DELETE FROM record_tags WHERE trip_id=new.trip_id AND kind=new.kind AND record_id=new.id;
  INSERT INTO record_tags SELECT new.trip_id,new.kind,new.id,value
    FROM json_each(new.payload_json,'$.companions') WHERE type='text' GROUP BY value;
  INSERT INTO changes(trip_id,kind,record_id,revision,operation)
    VALUES(new.trip_id,new.kind,new.id,new.revision,CASE WHEN new.deleted=1 THEN 'delete' ELSE 'upsert' END);
  -- Existing clients must discard a now-wider cache and rebootstrap when
  -- membership, referenced contacts or participant account links change.
  UPDATE sync_state SET epoch=epoch+1 WHERE
    coalesce(json_extract(old.payload_json,'$.companions'),'[]')<>coalesce(json_extract(new.payload_json,'$.companions'),'[]')
    OR coalesce(json_extract(old.payload_json,'$.contactId'),'')<>coalesce(json_extract(new.payload_json,'$.contactId'),'')
    OR new.kind='companion'
    OR (new.deleted<>old.deleted AND (json_extract(old.payload_json,'$.contactId') IS NOT NULL OR new.kind IN ('contact','destination')));
END;
CREATE TRIGGER grant_created AFTER INSERT ON trip_grants BEGIN
  UPDATE sync_state SET epoch=epoch+1;
END;
CREATE TRIGGER grant_changed AFTER UPDATE ON trip_grants BEGIN
  UPDATE sync_state SET epoch=epoch+1;
END;
CREATE TRIGGER grant_removed AFTER DELETE ON trip_grants BEGIN
  UPDATE sync_state SET epoch=epoch+1;
END;
