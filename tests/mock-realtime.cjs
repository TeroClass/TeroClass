// Simulated Supabase Realtime for the e2e tests: the Phoenix websocket protocol of realtime-js (vsn 2.0.0: JSON arrays
// [join_ref, ref, topic, event, payload]; user broadcasts as binary "userBroadcastPush" frames), served with Playwright's
// routeWebSocket. ONE relay shared by every browser context of a test, so a teacher and a student in two contexts see
// each other's broadcasts. Authorization mirrors the realtime.messages policies of 001_base.sql: a PRIVATE channel
// "classdoc:<session>" can be joined by whoever has access to the class document and only participants can send;
// a public channel "classdoc-<key>" needs the unguessable key. attach(ctx, {unavailable: true}) simulates a project
// without Realtime (the socket closes at once: the app must fall back to polling).
module.exports = function createRealtime({ tokUser, canRealtime, publicTopicOk }) {
  const topics = new Map(); // full topic ("realtime:classdoc:…") → Set(conn)
  const log = { joins: [], denied: [], broadcasts: [] };
  const conns = new Set();
  const decodeBinary = buf => {
    const b = Buffer.from(buf); if (b[0] !== 3) return null;
    const [jl, rl, tl, el, ml, enc] = [b[1], b[2], b[3], b[4], b[5], b[6]]; let o = 7;
    const take = n => { const s = b.slice(o, o + n).toString('utf8'); o += n; return s; };
    const join_ref = take(jl); const ref = take(rl); const topic = take(tl); const event = take(el); take(ml);
    const rest = b.slice(o);
    let payload = null; try { payload = enc === 1 ? JSON.parse(rest.toString('utf8') || 'null') : rest; } catch (e) { payload = null; }
    return { join_ref, ref, topic, event, payload };
  };
  function attach(ctx, opts = {}) {
    return ctx.routeWebSocket(/\/realtime\/v1\/websocket/, ws => {
      if (opts.unavailable) { ws.close({ code: 1011, reason: 'Realtime unavailable' }); return; }
      const conn = { ws, token: '', perms: new Map() }; conns.add(conn);
      const send = arr => { try { ws.send(JSON.stringify(arr)); } catch (e) { /* closed */ } };
      const reply = (m, status, response = {}) => send([m.join_ref ?? null, m.ref ?? null, m.topic, 'phx_reply', { status, response }]);
      const broadcast = (m, event, payload) => {
        const perm = conn.perms.get(m.topic);
        if (!perm || !perm.send) { log.denied.push({ topic: m.topic, event, why: 'send' }); return; }
        log.broadcasts.push({ topic: m.topic, event });
        for (const other of topics.get(m.topic) || []) if (other !== conn) { try { other.ws.send(JSON.stringify([null, null, m.topic, 'broadcast', { type: 'broadcast', event, payload }])); } catch (e) { /* closed */ } }
      };
      ws.onMessage(msg => {
        if (typeof msg !== 'string') { const m = decodeBinary(msg); if (m) { broadcast(m, m.event, m.payload); if (m.ref) reply(m, 'ok'); } return; }
        let arr; try { arr = JSON.parse(msg); } catch (e) { return; }
        const m = Array.isArray(arr) ? { join_ref: arr[0], ref: arr[1], topic: arr[2], event: arr[3], payload: arr[4] } : arr;
        switch (m.event) {
          case 'heartbeat': reply(m, 'ok'); break;
          case 'access_token': if (m.payload?.access_token) conn.token = m.payload.access_token; reply(m, 'ok'); break;
          case 'phx_join': {
            if (m.payload?.access_token) conn.token = m.payload.access_token;
            const me = tokUser(conn.token); const name = String(m.topic || '').replace(/^realtime:/, ''); const priv = !!m.payload?.config?.private;
            const canListen = priv ? canRealtime(me, name, false) : publicTopicOk(name);
            if (!canListen) { log.denied.push({ topic: name, priv, why: 'join' }); reply(m, 'error', { reason: 'Unauthorized: You do not have permissions to read from this Channel topic: ' + name }); break; }
            conn.perms.set(m.topic, { send: priv ? canRealtime(me, name, true) : true });
            if (!topics.has(m.topic)) topics.set(m.topic, new Set());
            topics.get(m.topic).add(conn);
            log.joins.push({ topic: name, priv, user: me?.id || null });
            reply(m, 'ok', { postgres_changes: [] });
            break;
          }
          case 'phx_leave': topics.get(m.topic)?.delete(conn); conn.perms.delete(m.topic); reply(m, 'ok'); break;
          case 'broadcast': broadcast(m, m.payload?.event, m.payload?.payload); if (m.ref) reply(m, 'ok'); break;
          default: if (m.ref) reply(m, 'ok');
        }
      });
      ws.onClose(() => { conns.delete(conn); for (const set of topics.values()) set.delete(conn); });
    });
  }
  function reset() { topics.clear(); conns.clear(); log.joins = []; log.denied = []; log.broadcasts = []; }
  return { attach, reset, log, topics };
};
