'use strict';

/**
 * Minimal in-memory stand-in for Socket.IO's server API, used to exercise the
 * REAL handler code (src/socketHandlers.js) without needing the socket.io
 * package. It implements only what the handlers use.
 */
let counter = 0;

class FakeSocket {
  constructor(io, { ip = '10.0.0.1', auth = {}, headers = {}, onEmit = null } = {}) {
    counter += 1;
    this.io = io;
    this.id = `fake-socket-${counter}`;
    this.handshake = { address: ip, headers, auth };
    this.data = {};
    this.handlers = {};
    this.middlewares = [];
    this.rooms = new Set();
    this.received = []; // everything the server sent to this client
    this.connected = true;
    this.onEmit = onEmit; // optional hook, used by the browser simulation to forward events
  }

  // ---- server-side API used by the handlers ----
  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
  }

  use(fn) {
    this.middlewares.push(fn);
  }

  emit(event, payload) {
    this.received.push({ event, payload });
    if (this.onEmit) this.onEmit(event, payload);
  }

  join(room) {
    this.rooms.add(room);
  }

  leave(room) {
    this.rooms.delete(room);
  }

  disconnect() {
    this._close('server namespace disconnect');
  }

  // ---- client-side helpers for tests ----
  /**
   * Send an event as the client would. Resolves with the ack payload, or
   * `undefined` when the handler does not ack, or `{ dropped: true }` when a
   * socket middleware swallowed the packet.
   */
  send(event, payload) {
    return new Promise((resolve) => {
      if (!this.connected) return resolve({ ok: false, error: 'not_connected' });
      const ack = (body) => resolve(body);
      const packet = [event, payload, ack];
      let reachedHandlers = false;
      const run = (i) => {
        if (i < this.middlewares.length) {
          this.middlewares[i](packet, () => run(i + 1));
          return;
        }
        reachedHandlers = true;
        (this.handlers[event] || []).forEach((h) => h(payload, ack));
        // Handlers reply synchronously; if no ack happened by now there never will be.
        resolve(undefined);
      };
      run(0);
      if (!reachedHandlers) resolve({ dropped: true });
      return undefined;
    });
  }

  /** Simulate the client (or network) closing the connection. */
  drop() {
    this._close('transport close');
  }

  _close(reason) {
    if (!this.connected) return;
    this.connected = false;
    this.rooms.clear();
    (this.handlers.disconnect || []).forEach((h) => h(reason));
  }

  events(name) {
    return this.received.filter((r) => r.event === name).map((r) => r.payload);
  }

  last(name) {
    const list = this.events(name);
    return list[list.length - 1];
  }

  clear() {
    this.received.length = 0;
  }
}

class FakeIO {
  constructor() {
    this.middlewares = [];
    this.connectionHandlers = [];
    this.sockets = [];
  }

  use(fn) {
    this.middlewares.push(fn);
  }

  on(event, fn) {
    if (event === 'connection') this.connectionHandlers.push(fn);
  }

  /** Open a client connection. Returns { socket } or { error }. */
  connect(opts = {}) {
    const socket = new FakeSocket(this, opts);
    let error = null;
    for (const mw of this.middlewares) {
      let failed = null;
      mw(socket, (err) => { failed = err || null; });
      if (failed) { error = failed; break; }
    }
    if (error) return { error, socket: null };
    this.sockets.push(socket);
    this.connectionHandlers.forEach((h) => h(socket));
    return { socket, error: null };
  }
}

module.exports = { FakeIO, FakeSocket };
