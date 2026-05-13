const net = require('net');

const PORT = process.env.PORT || 4000;

// rooms[code] = { host: socket|null, hostName: string, viewers: Set<socket> }
const rooms = {};

function getRoom(code) {
    if (!rooms[code]) rooms[code] = { host: null, hostName: '', viewers: new Set() };
    return rooms[code];
}
function cleanup(code) {
    const r = rooms[code];
    if (r && !r.host && r.viewers.size === 0) delete rooms[code];
}

// ── Protocol ──────────────────────────────────────────────────────────────────
// Handshake (first line, JSON + \n):
//   HOST:   { "role":"host",   "code":"ABCDEF", "name":"MonPseudo" }
//   VIEWER: { "role":"viewer", "code":"ABCDEF" }
//
// Server response (JSON + \n):
//   { "ok":true,  "role":"host"|"viewer", "code":"...", "hostName":"..." }
//   { "ok":false, "reason":"room_taken"|"no_host" }
//
// Frames (host → server → viewers):
//   [4 bytes LE = length][<length> bytes JPEG]
// ─────────────────────────────────────────────────────────────────────────────

const server = net.createServer((socket) => {
    socket.setNoDelay(true);

    let role = null, code = null, hostName = '';
    let handshakeDone = false;
    let hsRaw = '';
    let parseBuf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
        if (!handshakeDone) {
            hsRaw += chunk.toString('utf8');
            const nl = hsRaw.indexOf('\n');
            if (nl === -1) return;

            const line = hsRaw.slice(0, nl).trim();
            const rest = Buffer.from(hsRaw.slice(nl + 1), 'utf8');
            handshakeDone = true;

            let msg;
            try { msg = JSON.parse(line); } catch { socket.destroy(); return; }

            role     = msg.role;
            code     = (msg.code || '').toUpperCase().slice(0, 12);
            hostName = (msg.name || 'Anonyme').slice(0, 32);

            if (!role || !code) { socket.destroy(); return; }

            const r = getRoom(code);

            if (role === 'host') {
                if (r.host) {
                    socket.write(JSON.stringify({ ok: false, reason: 'room_taken' }) + '\n');
                    socket.destroy(); return;
                }
                r.host     = socket;
                r.hostName = hostName;
                socket.write(JSON.stringify({ ok: true, role: 'host', code, hostName }) + '\n');
                console.log(`[HOST+] room=${code} name=${hostName} ip=${socket.remoteAddress}`);
                if (rest.length > 0) handleHostData(rest);

            } else if (role === 'viewer') {
                if (!r.host) {
                    socket.write(JSON.stringify({ ok: false, reason: 'no_host' }) + '\n');
                    socket.destroy(); return;
                }
                r.viewers.add(socket);
                socket.write(JSON.stringify({ ok: true, role: 'viewer', code, hostName: r.hostName }) + '\n');
                console.log(`[VIEW+] room=${code} viewers=${r.viewers.size} ip=${socket.remoteAddress}`);
            } else {
                socket.destroy();
            }
            return;
        }

        if (role === 'host') handleHostData(chunk);
        // viewers only receive, never send frames
    });

    function handleHostData(chunk) {
        parseBuf = Buffer.concat([parseBuf, chunk]);
        while (parseBuf.length >= 4) {
            const len = parseBuf.readUInt32LE(0);
            if (len > 20 * 1024 * 1024) { socket.destroy(); return; }
            if (parseBuf.length < 4 + len) break;
            const frame = parseBuf.slice(4, 4 + len);
            parseBuf    = parseBuf.slice(4 + len);
            broadcast(frame);
        }
    }

    function broadcast(frame) {
        const r = rooms[code];
        if (!r) return;
        const hdr = Buffer.allocUnsafe(4);
        hdr.writeUInt32LE(frame.length, 0);
        const pkt = Buffer.concat([hdr, frame]);
        for (const v of r.viewers) try { v.write(pkt); } catch {}
    }

    socket.on('close', () => {
        if (!code) return;
        const r = rooms[code];
        if (!r) return;
        if (role === 'host') {
            console.log(`[HOST-] room=${code}`);
            r.host = null;
            for (const v of r.viewers) {
                try { v.write(JSON.stringify({ event: 'host_left' }) + '\n'); v.destroy(); } catch {}
            }
            r.viewers.clear();
        } else if (role === 'viewer') {
            r.viewers.delete(socket);
            console.log(`[VIEW-] room=${code} viewers=${r.viewers.size}`);
        }
        cleanup(code);
    });

    socket.on('error', () => socket.destroy());
});

server.listen(PORT, '0.0.0.0', () =>
    console.log(`\n  ScreenShare Relay — port ${PORT}\n`));
