#!/usr/bin/env node
/**
 * DriveQL Wire Proxy Bridge (`driveql-proxy`)
 * Emulates a local PostgreSQL server on 127.0.0.1:5432.
 * Translates PostgreSQL binary wire protocol packets from psql / Prisma / Drizzle
 * into HTTP requests to the DriveQL Cloudflare Worker.
 */

import net from 'node:net';

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    port: 5432,
    host: '127.0.0.1',
    endpoint: 'http://localhost:4321',
    instance: '',
    token: '',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) config.port = parseInt(args[++i], 10);
    else if (args[i] === '--host' && args[i + 1]) config.host = args[++i];
    else if (args[i] === '--endpoint' && args[i + 1]) config.endpoint = args[++i].replace(/\/$/, '');
    else if (args[i] === '--instance' && args[i + 1]) config.instance = args[++i];
    else if (args[i] === '--token' && args[i + 1]) config.token = args[++i];
  }

  return config;
}

const config = parseArgs();

if (!config.instance) {
  console.log(`
DriveQL PostgreSQL Wire Proxy Bridge

Usage:
  node ./src/cli/proxy.mjs --instance <INSTANCE_ID> --token <API_KEY> [--port 5432] [--endpoint http://localhost:4321]

Options:
  --instance   Target DriveQL database instance ID (required)
  --token      DriveQL API key generated from the dashboard (required)
  --port       Local TCP port to listen on (default: 5432)
  --endpoint   DriveQL server endpoint (default: http://localhost:4321)
  --host       Host to bind (default: 127.0.0.1)
  `);
  process.exit(1);
}

// PostgreSQL Wire Protocol Helpers
function writeBuffer(socket, type, payload) {
  const length = payload.length + 4;
  const header = Buffer.alloc(5);
  header.write(type, 0, 1, 'ascii');
  header.writeInt32BE(length, 1);
  socket.write(Buffer.concat([header, payload]));
}

function sendAuthOk(socket) {
  // 'R' AuthenticationOk (payload: int32 = 0)
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(0, 0);
  writeBuffer(socket, 'R', payload);
}

function sendReadyForQuery(socket) {
  // 'Z' ReadyForQuery (payload: 'I' idle in transaction block)
  const payload = Buffer.from('I', 'ascii');
  writeBuffer(socket, 'Z', payload);
}

function sendCommandComplete(socket, tag) {
  // 'C' CommandComplete
  const payload = Buffer.concat([Buffer.from(tag, 'utf-8'), Buffer.from([0])]);
  writeBuffer(socket, 'C', payload);
}

function sendRowDescription(socket, columns) {
  // 'T' RowDescription
  const buffers = [];
  const colCountBuf = Buffer.alloc(2);
  colCountBuf.writeInt16BE(columns.length, 0);
  buffers.push(colCountBuf);

  for (const col of columns) {
    const nameBuf = Buffer.concat([Buffer.from(col, 'utf-8'), Buffer.from([0])]);
    const infoBuf = Buffer.alloc(18);
    infoBuf.writeInt32BE(0, 0);      // tableOID
    infoBuf.writeInt16BE(0, 4);      // columnAttributeNumber
    infoBuf.writeInt32BE(25, 6);     // dataTypeOID (25 = text)
    infoBuf.writeInt16BE(-1, 10);    // dataTypeSize
    infoBuf.writeInt32BE(-1, 12);    // typeModifier
    infoBuf.writeInt16BE(0, 16);     // formatCode (0 = text)
    buffers.push(nameBuf, infoBuf);
  }

  writeBuffer(socket, 'T', Buffer.concat(buffers));
}

function sendDataRow(socket, values) {
  // 'D' DataRow
  const buffers = [];
  const countBuf = Buffer.alloc(2);
  countBuf.writeInt16BE(values.length, 0);
  buffers.push(countBuf);

  for (const val of values) {
    if (val === null || val === undefined) {
      const nullBuf = Buffer.alloc(4);
      nullBuf.writeInt32BE(-1, 0);
      buffers.push(nullBuf);
    } else {
      const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
      const valBuf = Buffer.from(strVal, 'utf-8');
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeInt32BE(valBuf.length, 0);
      buffers.push(lenBuf, valBuf);
    }
  }

  writeBuffer(socket, 'D', Buffer.concat(buffers));
}

// Create TCP Server
const server = net.createServer((socket) => {
  let isHandshakeComplete = false;

  socket.on('data', async (data) => {
    try {
      // 1. Initial Handshake / SSL negotiation
      if (!isHandshakeComplete) {
        if (data.length >= 8) {
          const code = data.readInt32BE(4);
          if (code === 80877103) {
            // SSLRequest: reply 'N' (SSL not supported over local proxy)
            socket.write(Buffer.from('N', 'ascii'));
            return;
          }
          if (code === 196608) {
            // Protocol 3.0 StartupMessage
            sendAuthOk(socket);
            sendReadyForQuery(socket);
            isHandshakeComplete = true;
            return;
          }
        }
      }

      // 2. Query execution message ('Q')
      const msgType = String.fromCharCode(data[0]);
      if (msgType === 'Q') {
        const queryText = data.subarray(5, data.length - 1).toString('utf-8').trim();
        if (!queryText) {
          sendReadyForQuery(socket);
          return;
        }

        // Execute query against DriveQL API
        const res = await fetch(`${config.endpoint}/api/instances/${config.instance}/query`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
          },
          body: JSON.stringify({ query: queryText }),
        });

        const result = await res.json();

        if (!res.ok || result.error) {
          // 'E' ErrorResponse
          const errString = result.error || 'SQL execution failed';
          const payload = Buffer.concat([
            Buffer.from('SFATAL', 'ascii'),
            Buffer.from([0]),
            Buffer.from(`M${errString}`, 'utf-8'),
            Buffer.from([0, 0]),
          ]);
          writeBuffer(socket, 'E', payload);
        } else {
          const rows = result.rows || [];
          if (rows.length > 0) {
            const cols = Object.keys(rows[0]);
            sendRowDescription(socket, cols);
            for (const r of rows) {
              sendDataRow(socket, cols.map((c) => r[c]));
            }
          }
          sendCommandComplete(socket, `SELECT ${rows.length}`);
        }

        sendReadyForQuery(socket);
      } else if (msgType === 'X') {
        // Terminate
        socket.end();
      }
    } catch (err) {
      console.error('Socket processing error:', err);
      sendReadyForQuery(socket);
    }
  });

  socket.on('error', (err) => {
    // Ignore ECONNRESET on client disconnect
    if (err.code !== 'ECONNRESET') {
      console.error('Socket error:', err.message);
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                   DriveQL Wire Proxy Bridge                    ║
╠════════════════════════════════════════════════════════════════╣
║  Local Address    : tcp://${config.host}:${config.port}                ║
║  DriveQL Instance : ${config.instance}                           ║
║  Edge Endpoint    : ${config.endpoint}                   ║
╚════════════════════════════════════════════════════════════════╝

Ready! You can now connect with psql or any PostgreSQL client:
  psql -h ${config.host} -p ${config.port} -U postgres -d driveql
`);
});
