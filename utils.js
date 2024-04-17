import Y from 'yjs';
import syncProtocol from 'y-protocols/sync';
import awarenessProtocol from 'y-protocols/awareness';
import { createEncoder, createDecoder, writeVarUint, readVarUint, writeVarUint8Array, readVarUint8Array } from 'lib0/encoding';
import { map, setIfUndefined } from 'lib0/map';
import debounce from 'lodash.debounce';
import { callbackHandler, isCallbackSet } from './callback.js';

const CALLBACK_DEBOUNCE_WAIT = parseInt(process.env.CALLBACK_DEBOUNCE_WAIT || '2000');
const CALLBACK_DEBOUNCE_MAXWAIT = parseInt(process.env.CALLBACK_DEBOUNCE_MAXWAIT || '10000');

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const wsReadyStateClosing = 2;
const wsReadyStateClosed = 3;

const gcEnabled = process.env.GC !== 'false' && process.env.GC !== '0';
const persistenceDir = process.env.YPERSISTENCE;

let persistence = null;
if (typeof persistenceDir === 'string') {
  console.info('Persisting documents to "' + persistenceDir + '"');
  const LeveldbPersistence = require('y-leveldb').LeveldbPersistence;
  const ldb = new LeveldbPersistence(persistenceDir);
  persistence = {
    provider: ldb,
    bindState: async (docName, ydoc) => {
      const persistedYdoc = await ldb.getYDoc(docName);
      const newUpdates = Y.encodeStateAsUpdate(ydoc);
      ldb.storeUpdate(docName, newUpdates);
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
      ydoc.on('update', update => {
        ldb.storeUpdate(docName, update);
      });
    },
    writeState: async (_docName, _ydoc) => {}
  };
}

export const setPersistence = (persistence_) => {
  persistence = persistence_;
};

export const getPersistence = () => persistence;

const docs = new Map();
export { docs };

const messageSync = 0;
const messageAwareness = 1;

const updateHandler = (update, _origin, doc, _tr) => {
  const encoder = createEncoder();
  writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);
  doc.conns.forEach((_, conn) => send(doc, conn, message));
};

let contentInitializor = _ydoc => Promise.resolve();

export const setContentInitializor = (f) => {
  contentInitializor = f;
};

export class WSSharedDoc extends Y.Doc {
  constructor(name) {
    super({ gc: gcEnabled });
    this.name = name;
    this.conns = new Map();
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);
    const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed);
      if (conn !== null) {
        const connControlledIDs = this.conns.get(conn);
        if (connControlledIDs !== undefined) {
          added.forEach(clientID => { connControlledIDs.add(clientID); });
          removed.forEach(clientID => { connControlledIDs.delete(clientID); });
        }
      }
      const encoder = createEncoder();
      writeVarUint(encoder, messageAwareness);
      writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients));
      const buff = encoding.toUint8Array(encoder);
      this.conns.forEach((_, c) => {
        send(this, c, buff);
      });
    };
    this.awareness.on('update', awarenessChangeHandler);
    this.on('update', updateHandler);
    if (isCallbackSet) {
      this.on('update', debounce(
        callbackHandler,
        CALLBACK_DEBOUNCE_WAIT,
        { maxWait: CALLBACK_DEBOUNCE_MAXWAIT }
      ));
    }
    this.whenInitialized = contentInitializor(this);
  }
}

export const getYDoc = (docname, gc = true) => setIfUndefined(docs, docname, () => {
  const doc = new WSSharedDoc(docname);
  doc.gc = gc;
  if (persistence !== null) {
    persistence.bindState(docname, doc);
  }
  docs.set(docname, doc);
  return doc;
});

const messageListener = (conn, doc, message) => {
  try {
    const encoder = createEncoder();
    const decoder = createDecoder(message);
    const messageType = readVarUint(decoder);
    switch (messageType) {
      case messageSync:
        writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);

        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, readVarUint8Array(decoder), conn);
        break;
      }
    }
  } catch (err) {
    console.error(err);
    doc.emit('error', [err]);
  }
};

const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    const controlledIds = doc.conns.get(conn);
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null);
    if (doc.conns.size === 0 && persistence !== null) {
      persistence.writeState(doc.name, doc).then(() => {
        doc.destroy();
      });
      docs.delete(doc.name);
    }
  }
  conn.close();
};

const send = (doc, conn, m) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn);
  }
  try {
    conn.send(m, err => { if (err) closeConn(doc, conn); });
  } catch (e) {
    closeConn(doc, conn);
  }
};

const pingTimeout = 30000;

export const setupWSConnection = (conn, req, { docName = req.url.slice(1).split('?')[0], gc = true } = {}) => {
  conn.binaryType = 'arraybuffer';
  const doc = getYDoc(docName, gc);
  doc.conns.set(conn, new Set());
  conn.on('message', message => messageListener(conn, doc, new Uint8Array(message)));

  let pongReceived = true;
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) {
        closeConn(doc, conn);
      }
      clearInterval(pingInterval);
    } else if (doc.conns.has(conn)) {
      pongReceived = false;
      try {
        conn.ping();
      } catch (e) {
        closeConn(doc, conn);
        clearInterval(pingInterval);
      }
    }
  }, pingTimeout);

  conn.on('close', () => {
    closeConn(doc, conn);
    clearInterval(pingInterval);
  });

  conn.on('pong', () => {
    pongReceived = true;
  });

  {
    const encoder = createEncoder();
    writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(doc, conn, encoding.toUint8Array(encoder));
    const awarenessStates = doc.awareness.getStates();
    if (awarenessStates.size > 0) {
      const encoder = createEncoder();
      writeVarUint(encoder, messageAwareness);
      writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys())));
      send(doc, conn, encoding.toUint8Array(encoder));
    }
  }
};
