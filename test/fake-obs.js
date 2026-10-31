// Tiny obs-websocket v5 server for tests (with password auth). Records what it was asked.
const http = require("http"), crypto = require("crypto");
module.exports = function fakeObs(port, password) {
  const log = [];
  let recording = false, savingUntil = 0;
  const active = () => recording || Date.now() < savingUntil;
  const sha = (s) => crypto.createHash("sha256").update(s).digest("base64");
  const srv = http.createServer();
  srv.on("upgrade", (req, sock) => {
    const key = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    const send = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]); sock.write(Buffer.concat([h, b])); };
    const salt = "s4lt", challenge = "ch4ll";
    send({ op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1, authentication: { salt, challenge } } });
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const op = buf[0] & 15; let len = buf[1] & 127, o = 2;
        if (len === 126) { len = buf.readUInt16BE(2); o = 4; }
        if (buf.length < o + 4 + len) return;
        const mask = buf.slice(o, o + 4), data = Buffer.from(buf.slice(o + 4, o + 4 + len)).map((x, i) => x ^ mask[i % 4]);
        buf = buf.slice(o + 4 + len);
        if (op === 8) { sock.end(); return; }
        const m = JSON.parse(data.toString());
        if (m.op === 1) {
          if (m.d.authentication !== sha(sha(password + salt) + challenge)) { log.push("bad auth"); sock.end(); return; }
          send({ op: 2, d: { negotiatedRpcVersion: 1 } });
        } else if (m.op === 6) {
          const t = m.d.requestType; log.push(t);
          let data = {}, ok = true;
          if (t === "GetRecordStatus") data = { outputActive: active() };
          else if (t === "StartRecord") { ok = !active(); if (ok) recording = true; else log.push("start while saving"); }
          else if (t === "StopRecord") { ok = recording; recording = false; savingUntil = Date.now() + 4000; data = { outputPath: "C:/rec/take.mp4" }; }
          send({ op: 7, d: { requestType: t, requestId: m.d.requestId, requestStatus: { result: ok, code: ok ? 100 : 500 }, responseData: data } });
        }
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r({ log, close: () => srv.close(), get recording() { return active(); } })));
};
