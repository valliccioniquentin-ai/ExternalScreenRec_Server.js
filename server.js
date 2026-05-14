const net = require('net');
const rooms = new Map();

const server = net.createServer(socket => {
  let buf = '';
  let role = null;
  let roomCode = null;

  socket.on('data', d => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (role) continue; // handshake déjà fait

        role = msg.role;
        roomCode = msg.code;

        if (role === 'host') {
          rooms.set(roomCode, {
            socket,
            name: msg.name,
            hostIp: socket.remoteAddress,   // IP publique de l'hôte
            directPort: msg.directPort      // port TCP direct de l'hôte
          });
          socket.write(JSON.stringify({ ok: true }) + '\n');
          socket.on('close', () => rooms.delete(roomCode));

        } else if (role === 'viewer') {
          const room = rooms.get(roomCode);
          if (!room) {
            socket.write(JSON.stringify({ ok: false, error: 'no_host' }) + '\n');
            socket.destroy();
            return;
          }

          // Envoie les infos de connexion directe au viewer
          socket.write(JSON.stringify({
            ok: true,
            hostName: room.name,
            hostIp: room.hostIp,
            hostPort: room.directPort
          }) + '\n');

          // Fallback relay (si P2P échoue, les frames passent quand même ici)
          room.socket.pipe(socket);
          socket.pipe(room.socket);
        }

      } catch (e) {}
    }
  });

  socket.on('error', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Relay listening on', PORT));
