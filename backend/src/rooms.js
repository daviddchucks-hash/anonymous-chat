'use strict';

const crypto = require('crypto');

/**
 * Temporary private conversations between two Chat ID users, held only in memory.
 * Room ids and Socket.IO room names are never sent to clients.
 */
class RoomManager {
  constructor({ maxMessages = 300 } = {}) {
    this.maxMessages = maxMessages;
    this.rooms = new Map();
  }

  create(userA, userB) {
    const id = crypto.randomBytes(16).toString('hex');

    const room = {
      id,
      name: `room:${id}`, // Socket.IO room name (server-side only)
      members: [userA.id, userB.id],
      chatIds: { [userA.id]: userA.chatId, [userB.id]: userB.chatId },
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
    room.chatIds = {};
    room.members = [];
    this.rooms.delete(id);
    return true;
  }

  get size() {
    return this.rooms.size;
  }
}

module.exports = { RoomManager };
