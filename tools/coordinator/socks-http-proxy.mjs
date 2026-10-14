// HTTP CONNECT proxy on 127.0.0.1:3128 that dials through the SOCKS5 tunnel on 127.0.0.1:1080 (for Node's NODE_USE_ENV_PROXY=1 fetch)
import net from 'node:net';
const SOCKS = { host: '127.0.0.1', port: 1080 };
function socksConnect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCKS.port, SOCKS.host);
    s.once('error', reject);
    s.once('connect', () => s.write(Buffer.from([5, 1, 0])));
    let step = 0;
    s.on('data', function onData(b) {
      if (step === 0) {
        if (b[0] !== 5 || b[1] !== 0) return reject(new Error('socks auth'));
        const h = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
        step = 1;
      } else if (step === 1) {
        if (b[1] !== 0) return reject(new Error('socks connect refused ' + b[1]));
        s.removeListener('data', onData);
        resolve(s);
      }
    });
  });
}
net.createServer((c) => {
  c.once('data', async (buf) => {
    const m = /^CONNECT ([^:]+):(\d+) HTTP/.exec(buf.toString('latin1').split('\r\n')[0]);
    if (!m) { c.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n'); return; }
    try {
      const up = await socksConnect(m[1], Number(m[2]));
      c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(c); c.pipe(up); up.on('error', () => c.destroy()); c.on('error', () => up.destroy()); up.on('close', () => c.destroy()); c.on('close', () => up.destroy());
    } catch (e) { c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); }
  });
  c.on('error', () => {});
}).listen(3128, '127.0.0.1', () => console.log('socks-http-proxy on 127.0.0.1:3128'));
