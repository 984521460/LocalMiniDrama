const net = require('node:net');

function invalid() {
  const error = new TypeError('SSH tunnel input is invalid');
  error.code = 'SSH_TUNNEL_INPUT_INVALID';
  return error;
}

function createSshTunnelManager({ createServer = net.createServer } = {}) {
  if (typeof createServer !== 'function') throw invalid();

  async function open({ session, remotePort }) {
    if (!session || typeof session !== 'object'
      || typeof session.forwardOut !== 'function' || typeof session.close !== 'function'
      || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw invalid();
    let closed = false;
    const sockets = new Set();
    const server = createServer((localSocket) => {
      sockets.add(localSocket);
      localSocket.once('close', () => sockets.delete(localSocket));
      Promise.resolve(session.forwardOut(
        '127.0.0.1',
        Number.isInteger(localSocket.remotePort) ? localSocket.remotePort : 0,
        '127.0.0.1',
        remotePort,
      )).then((remoteStream) => {
        if (closed) {
          localSocket.destroy();
          remoteStream.destroy?.();
          return;
        }
        sockets.add(remoteStream);
        remoteStream.once?.('close', () => sockets.delete(remoteStream));
        localSocket.once('error', () => remoteStream.destroy?.());
        remoteStream.once?.('error', () => localSocket.destroy());
        localSocket.pipe(remoteStream).pipe(localSocket);
      }, () => localSocket.destroy());
    });

    try {
      await new Promise((resolve, reject) => {
        const onError = () => reject(invalid());
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      await session.close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
      server.close();
      await session.close();
      throw invalid();
    }

    const close = async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy?.();
      await new Promise((resolve) => server.close(() => resolve()));
      await session.close();
    };

    return Object.freeze({
      host: '127.0.0.1',
      port: address.port,
      origin: `http://127.0.0.1:${address.port}`,
      close,
    });
  }

  return Object.freeze({ open });
}

module.exports = { createSshTunnelManager };
