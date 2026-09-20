'use strict';

const crypto = require('crypto');

/**
 * Temporary private conversations, held only in memory.
 * A room and everything in it (including message text) is deleted the moment
 * the conversation ends. Room ids and Socket.IO room names are never sent to clients.
 */
class RoomManager {
  constructor({ maxMessages = 300 } = {}) {
    this.maxMessages = maxMessages;
    this.rooms = new Map();
  }

  /** Random display name such as "Stranger-48291". Not derived from any user data. */
  static generateAlias() {
    return `Stranger-${crypto.randomInt(10000, 100000)}`;
  }

  create(userIdA, userIdB) {
    const id = crypto.randomBytes(16).toString('hex');
    const aliasA = RoomManager.generateAlias();
    let aliasB = RoomManager.generateAlias();
    while (aliasB === aliasA) aliasB = RoomManager.generateAlias();

    const room = {
      id,
      name: `room:${id}`, // Socket.IO room name (server-side only)
      members: [userIdA, userIdB],
      aliases: { [userIdA]: aliasA, [userIdB]: aliasB },
      messages: [],
      nextMessageId: 1,
      reportedBy: new Set(),
      createdAt: Date.now(),
    };
    this.rooms.set(id, room);
    return room;
  }

  get(id) {
    return id ? this.rooms.get(id) || null : null;
  }

  partnerId(room, userId) {
    return room.members[0] === userId ? room.members[1] : room.members[0];
  }

  addMessage(roomId, senderId, text, now = Date.now()) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const message = { id: room.nextMessageId++, senderId, text, ts: now };
    room.messages.push(message);
    if (room.messages.length > this.maxMessages) room.messages.shift();
    return message;
  }

  /** Delete the room and wipe its message data. */
  destroy(id) {
    const room = this.rooms.get(id);
    if (!room) return false;
    room.messages.length = 0;
    room.reportedBy.clear();
    room.aliases = {};
    room.members = [];
    this.rooms.delete(id);
    return true;
  }

  get size() {
    return this.rooms.size;
  }
}

module.exports = { RoomManager };
