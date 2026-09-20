(() => {
  'use strict';

  const KEYS = {
    chatId: 'passerby.chatId',
    sid: 'passerby.sid',
  };

  const SEND_ERRORS = {
    empty: 'Type something first.',
    too_long: 'That message is too long.',
    links_not_allowed: 'Links are turned off in this chat.',
    blocked_content: "That message contains language that isn't allowed.",
    duplicate: "Please don't repeat the same message.",
    not_in_chat: 'This conversation has ended.',
    invalid_payload: 'That message could not be sent.',
    server_error: 'Something went wrong. Please try again.',
  };

  const CHAT_START_ERRORS = {
    invalid_chat_id: 'Invalid Chat ID format. Please check the ID.',
    cannot_chat_self: 'You cannot start a chat with your own Chat ID.',
    chat_id_not_found: 'Chat ID not found or unavailable.',
    user_busy: 'That user is currently in another chat.',
    already_in_chat: 'You are already in an active chat.',
    rate_limited: 'Too many connection attempts. Please wait a moment.',
  };

  const FATAL_TITLES = {
    banned: 'Access paused',
    too_many_connections: 'Too many open tabs',
    session_replaced: 'Opened in another tab',
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
    remove(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    banner: $('banner'),
    screens: {
      identity: $('screen-identity'),
      chat: $('screen-chat'),
      error: $('screen-error'),
    },
    myChatId: $('my-chat-id'),
    copyIdBtn: $('copy-id-btn'),
    copyStatus: $('copy-status'),
    regenIdBtn: $('regen-id-btn'),
    startChatForm: $('start-chat-form'),
    targetChatId: $('target-chat-id'),
    startChatError: $('start-chat-error'),
    startChatBtn: $('start-chat-btn'),
    peerIdDisplay: $('peer-id-display'),
    dot: $('status-dot'),
    statusText: $('status-text'),
    reportBtn: $('report-btn'),
    blockBtn: $('block-btn'),
    endBtn: $('end-btn'),
    messages: $('messages'),
    typing: $('typing'),
    composer: $('composer'),
    input: $('input'),
    sendBtn: $('send-btn'),
    counter: $('counter'),
    endedPanel: $('ended-panel'),
    endedTitle: $('ended-title'),
    endedText: $('ended-text'),
    returnIdentityBtn: $('return-identity-btn'),
    errorTitle: $('error-title'),
    errorText: $('error-text'),
    errorHomeBtn: $('error-home-btn'),
    reportDialog: $('report-dialog'),
    reportForm: $('report-form'),
    reportNote: $('report-note'),
    reportError: $('report-error'),
    reportCancel: $('report-cancel'),
    reportSubmit: $('report-submit'),
    confirmDialog: $('confirm-dialog'),
    confirmTitle: $('confirm-title'),
    confirmText: $('confirm-text'),
    confirmOk: $('confirm-ok'),
    confirmCancel: $('confirm-cancel'),
  };

  let socket = null;

  const state = {
    chatId: store.get(KEYS.chatId) || '',
    sid: store.get(KEYS.sid) || '',
    connected: false,
    inChat: false,
    ended: false,
    peerChatId: '',
    partnerOnline: true,
    blocked: false,
    maxLen: 500,
    seen: new Set(),
    myTyping: false,
    typingStopTimer: null,
    theirTypingTimer: null,
    bannerTimer: null,
    fatal: false,
  };

  /* ------------------------------ helpers ------------------------------- */

  function formatChatIdInput(val) {
    let clean = val.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length > 12) clean = clean.slice(0, 12);
    let formatted = '';
    for (let i = 0; i < clean.length; i++) {
      if (i > 0 && i % 4 === 0) formatted += '-';
      formatted += clean[i];
    }
    return formatted;
  }

  function showScreen(name) {
    for (const [key, node] of Object.entries(el.screens)) {
      if (node) node.hidden = key !== name;
    }
    window.scrollTo(0, 0);
  }

  function showBanner(text, autoHideMs) {
    clearTimeout(state.bannerTimer);
    el.banner.textContent = text;
    el.banner.hidden = false;
    if (autoHideMs) state.bannerTimer = setTimeout(hideBanner, autoHideMs);
  }
  function hideBanner() {
    clearTimeout(state.bannerTimer);
    el.banner.hidden = true;
  }

  function fatal(code, message) {
    state.fatal = true;
    hideBanner();
    el.errorTitle.textContent = FATAL_TITLES[code] || 'Connection Problem';
    el.errorText.textContent = message || 'Something went wrong. Please try again in a moment.';
    showScreen('error');
    if (socket) socket.disconnect();
  }

  function updateIdentityDisplay() {
    el.myChatId.textContent = state.chatId || 'Generating…';
  }

  /* ------------------------------ messages ------------------------------ */

  function nearBottom() {
    const m = el.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 90;
  }
  function scrollToEnd() { el.messages.scrollTop = el.messages.scrollHeight; }

  function timeText(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function addSystem(text, warn) {
    const stick = nearBottom();
    const div = document.createElement('div');
    div.className = warn ? 'sys warn' : 'sys';
    div.textContent = text;
    el.messages.appendChild(div);
    if (stick) scrollToEnd();
  }

  function addMessage(m) {
    if (state.seen.has(m.id)) return;
    state.seen.add(m.id);
    const stick = nearBottom() || m.self;
    const div = document.createElement('div');
    div.className = m.self ? 'msg me' : 'msg them';
    const body = document.createElement('span');
    body.textContent = m.text;
    const time = document.createElement('time');
    time.dateTime = new Date(m.ts).toISOString();
    time.textContent = timeText(m.ts);
    div.append(body, time);
    el.messages.appendChild(div);
    if (stick) scrollToEnd();
  }

  function clearConversation() {
    el.messages.replaceChildren();
    state.seen.clear();
    setTyping(false);
    el.input.value = '';
    autosize();
    updateCounter();
  }

  function updateStatus() {
    let dot = 'ok';
    let text = 'Connected';
    if (state.ended) { dot = 'ended'; text = 'Chat ended'; }
    else if (!state.connected) { dot = 'off'; text = 'Reconnecting…'; }
    else if (!state.partnerOnline) { dot = 'warn'; text = 'User reconnecting…'; }
    el.dot.dataset.state = dot;
    el.statusText.textContent = text;

    const canSend = state.inChat && !state.ended && state.connected;
    el.sendBtn.disabled = !canSend;
    for (const b of [el.reportBtn, el.blockBtn, el.endBtn]) {
      b.disabled = !state.inChat || state.ended || !state.connected;
    }

    if (!state.connected && !state.fatal && state.inChat && !state.ended) {
      showBanner('Connection lost. Trying to reconnect…');
    } else if (state.connected && el.banner.textContent.startsWith('Connection lost')) {
      hideBanner();
    }
  }

  function setTyping(on) {
    clearTimeout(state.theirTypingTimer);
    el.typing.textContent = on ? `${state.peerChatId} is typing…` : '';
    if (on) state.theirTypingTimer = setTimeout(() => setTyping(false), 5000);
  }

  /* ---------------------------- conversation ---------------------------- */

  function enterChat({ peerChatId, messages, partnerOnline }, resumed) {
    clearConversation();
    state.inChat = true;
    state.ended = false;
    state.blocked = false;
    state.peerChatId = peerChatId;
    state.partnerOnline = partnerOnline !== false;

    el.peerIdDisplay.textContent = peerChatId;
    el.endedPanel.hidden = true;
    el.composer.hidden = false;
    el.input.readOnly = false;
    showScreen('chat');

    if (resumed) {
      addSystem(`Reconnected to chat with ${peerChatId}.`);
      (messages || []).forEach(addMessage);
    } else {
      addSystem(`Connected with ${peerChatId}. Chat messages are end-to-end private between you two.`);
    }
    scrollToEnd();
    updateStatus();
    if (!window.matchMedia('(pointer: coarse)').matches) el.input.focus();
  }

  function endChat(reason) {
    if (!state.inChat || state.ended) return;
    state.ended = true;
    state.inChat = false;
    state.partnerOnline = true;
    clearTimeout(state.typingStopTimer);
    state.myTyping = false;
    setTyping(false);

    const mine = reason === 'you_ended';
    if (!mine) addSystem('The other user has left the conversation.', true);
    el.endedText.textContent = mine
      ? (state.blocked
        ? "You blocked this user. The conversation has been deleted."
        : 'You ended the chat. The conversation has been deleted.')
      : 'The conversation has been deleted.';

    el.composer.hidden = true;
    el.endedPanel.hidden = false;
    updateStatus();
    scrollToEnd();
  }

  /* ------------------------------- sending ------------------------------ */

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 128)}px`;
  }

  function updateCounter() {
    const len = [...el.input.value].length;
    const show = len > state.maxLen * 0.8;
    el.counter.hidden = !show;
    el.counter.textContent = `${len}/${state.maxLen}`;
    el.counter.classList.toggle('over', len > state.maxLen);
  }

  function stopTyping() {
    clearTimeout(state.typingStopTimer);
    if (state.myTyping) {
      state.myTyping = false;
      if (socket && socket.connected) socket.emit('typing_stop');
    }
  }

  function onInput() {
    autosize();
    updateCounter();
    if (!state.inChat || state.ended || !socket || !socket.connected) return;
    if (!el.input.value.trim()) { stopTyping(); return; }
    if (!state.myTyping) {
      state.myTyping = true;
      socket.emit('typing_start');
    }
    clearTimeout(state.typingStopTimer);
    state.typingStopTimer = setTimeout(stopTyping, 2000);
  }

  function sendMessage() {
    const text = el.input.value.trim();
    if (!text || !state.inChat || state.ended) return;
    if (!socket || !socket.connected) { addSystem("You're offline. Message not sent.", true); return; }
    if ([...text].length > state.maxLen) { addSystem(SEND_ERRORS.too_long, true); return; }

    stopTyping();
    el.input.value = '';
    autosize();
    updateCounter();

    const restore = () => { if (!el.input.value) { el.input.value = text; autosize(); updateCounter(); } };
    socket.timeout(8000).emit('send_message', { text }, (err, res) => {
      if (err) { addSystem('Message not sent: no response from server.', true); restore(); return; }
      if (res && res.ok) return;
      const code = res && res.error;
      if (code === 'rate_limited') {
        const secs = Math.max(1, Math.ceil(((res && res.retryAfterMs) || 1000) / 1000));
        addSystem(`Sending messages too fast. Wait ${secs}s.`, true);
      } else {
        addSystem(SEND_ERRORS[code] || SEND_ERRORS.server_error, true);
      }
      if (code !== 'not_in_chat') restore();
    });
  }

  /* -------------------------------- dialogs ----------------------------- */

  function confirmAction({ title, text, okLabel }, onOk) {
    el.confirmTitle.textContent = title;
    el.confirmText.textContent = text;
    el.confirmOk.textContent = okLabel;
    const done = () => { el.confirmOk.onclick = null; el.confirmDialog.close(); };
    el.confirmOk.onclick = () => { done(); onOk(); };
    el.confirmDialog.showModal();
  }

  function submitReport() {
    const reason = (el.reportForm.querySelector('input[name="reason"]:checked') || {}).value || 'other';
    el.reportError.textContent = '';
    el.reportSubmit.disabled = true;
    socket.timeout(8000).emit('report_user', { reason, note: el.reportNote.value }, (err, res) => {
      el.reportSubmit.disabled = false;
      if (err) { el.reportError.textContent = 'No response from server. Try again.'; return; }
      if (res && res.ok) {
        el.reportDialog.close();
        el.reportNote.value = '';
        addSystem('Report submitted. Thank you.');
        return;
      }
      const map = {
        already_reported: 'You already reported this user.',
        rate_limited: 'Too many reports sent. Try again later.',
        not_in_chat: 'This conversation has ended.',
      };
      el.reportError.textContent = map[res && res.error] || 'Could not send report. Try again.';
    });
  }

  /* -------------------------------- socket ------------------------------ */

  const backendUrl = window.CONFIG && window.CONFIG.BACKEND_URL ? window.CONFIG.BACKEND_URL : '';

  if (typeof io !== 'function') {
    state.fatal = true;
    el.errorTitle.textContent = 'Socket.IO client missing';
    el.errorText.textContent = 'The required Socket.IO library failed to load.';
    showScreen('error');
    return;
  }

  socket = io(backendUrl, {
    auth: (cb) => cb({ sid: store.get(KEYS.sid) || undefined, chatId: store.get(KEYS.chatId) || undefined }),
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });

  socket.on('connect', () => {
    state.connected = true;
    updateStatus();
  });

  socket.on('disconnect', () => {
    state.connected = false;
    stopTyping();
    updateStatus();
    if (!state.inChat && !state.fatal && !state.ended) showBanner('Connection lost. Trying to reconnect…');
  });

  socket.on('connect_error', (err) => {
    const data = err && err.data;
    if (data && data.code) { fatal(data.code, data.message); return; }
    showBanner("Can't reach the backend server. Retrying…");
  });

  socket.on('connection_error', ({ code, message } = {}) => {
    if (FATAL_TITLES[code]) { fatal(code, message); return; }
    if (code === 'server_restarting') { showBanner(message || 'The server is restarting…'); return; }
    if (state.inChat && !state.ended) addSystem(message || 'Something went wrong.', true);
    else showBanner(message || 'Something went wrong.', 5000);
  });

  socket.on('session', (s) => {
    if (!s || typeof s.chatId !== 'string' || typeof s.sid !== 'string') return;
    state.chatId = s.chatId;
    state.sid = s.sid;
    store.set(KEYS.chatId, s.chatId);
    store.set(KEYS.sid, s.sid);
    updateIdentityDisplay();

    state.maxLen = (s.limits && s.limits.maxMessageLength) || 500;
    el.input.maxLength = state.maxLen;
    hideBanner();

    if (s.state === 'chatting' && s.chat) {
      enterChat({ ...s.chat }, true);
    } else {
      showScreen('identity');
    }
  });

  socket.on('identity_updated', (data) => {
    if (data && data.chatId) {
      state.chatId = data.chatId;
      if (data.sid) state.sid = data.sid;
      store.set(KEYS.chatId, state.chatId);
      if (data.sid) store.set(KEYS.sid, state.sid);
      updateIdentityDisplay();
    }
  });

  socket.on('chat_started', (data) => {
    if (!data) return;
    enterChat(data, false);
  });

  socket.on('receive_message', (m) => {
    if (!m || typeof m.text !== 'string') return;
    if (!m.self) setTyping(false);
    addMessage(m);
  });

  socket.on('typing_start', () => { if (state.inChat && !state.ended) setTyping(true); });
  socket.on('typing_stop', () => setTyping(false));

  socket.on('partner_status', ({ online } = {}) => {
    if (!state.inChat || state.ended) return;
    const was = state.partnerOnline;
    state.partnerOnline = online !== false;
    if (!state.partnerOnline) setTyping(false);
    if (was !== state.partnerOnline) {
      addSystem(state.partnerOnline ? `${state.peerChatId} is back.` : `${state.peerChatId} disconnected. Waiting for them to return…`, !state.partnerOnline);
    }
    updateStatus();
  });

  socket.on('chat_ended', ({ reason } = {}) => endChat(reason));

  /* ------------------------------ UI wiring ----------------------------- */

  el.copyIdBtn.addEventListener('click', () => {
    if (!state.chatId) return;
    navigator.clipboard.writeText(state.chatId).then(() => {
      el.copyStatus.textContent = 'Copied to clipboard!';
      setTimeout(() => { el.copyStatus.textContent = ''; }, 3000);
    }).catch(() => {
      el.copyStatus.textContent = 'Failed to copy.';
    });
  });

  el.regenIdBtn.addEventListener('click', () => {
    confirmAction(
      {
        title: 'Generate New Chat ID?',
        text: 'This will replace your current anonymous Chat ID identity. If you are in a chat, it will be ended.',
        okLabel: 'Generate New ID',
      },
      () => {
        socket.timeout(8000).emit('generate_new_chat_id', (err, res) => {
          if (err || !res || !res.ok) {
            showBanner('Could not generate new ID. Try again.');
            return;
          }
          state.chatId = res.chatId;
          store.set(KEYS.chatId, res.chatId);
          updateIdentityDisplay();
          showBanner('New Chat ID generated.', 3000);
        });
      }
    );
  });

  el.targetChatId.addEventListener('input', (e) => {
    el.targetChatId.value = formatChatIdInput(e.target.value);
    el.startChatError.hidden = true;
  });

  el.startChatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const targetChatId = formatChatIdInput(el.targetChatId.value);
    if (!targetChatId || targetChatId.length !== 14) {
      el.startChatError.textContent = 'Please enter a valid Chat ID (e.g. AC7K-X92P-Q4LM).';
      el.startChatError.hidden = false;
      return;
    }

    el.startChatBtn.disabled = true;
    el.startChatError.hidden = true;

    socket.timeout(8000).emit('start_chat_id', { targetChatId }, (err, res) => {
      el.startChatBtn.disabled = false;
      if (err) {
        el.startChatError.textContent = 'No response from server. Try again.';
        el.startChatError.hidden = false;
        return;
      }
      if (res && res.ok) {
        el.targetChatId.value = '';
        return;
      }
      const errCode = res && res.error;
      el.startChatError.textContent = CHAT_START_ERRORS[errCode] || 'Could not connect with that Chat ID.';
      el.startChatError.hidden = false;
    });
  });

  el.composer.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
  el.input.addEventListener('input', onInput);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  el.input.addEventListener('blur', stopTyping);

  el.endBtn.addEventListener('click', () => {
    confirmAction(
      { title: 'End this chat?', text: 'The conversation will be deleted and cannot be recovered.', okLabel: 'End Chat' },
      () => {
        socket.timeout(8000).emit('end_chat', (err, res) => {
          if (err) { addSystem("Couldn't reach server. Try again.", true); return; }
          if (res && res.ok && res.ended === false) endChat('partner_disconnected');
        });
      }
    );
  });

  el.blockBtn.addEventListener('click', () => {
    confirmAction(
      { title: 'Block this user?', text: "The chat will end and you won't be able to connect with this Chat ID again.", okLabel: 'Block and End' },
      () => {
        state.blocked = true;
        socket.timeout(8000).emit('block_user', (err, res) => {
          if (err) { state.blocked = false; addSystem("Couldn't reach server. Try again.", true); return; }
          if (res && res.ok) return;
          state.blocked = false;
          if (res && res.error === 'not_in_chat') endChat('partner_disconnected');
        });
      }
    );
  });

  el.reportBtn.addEventListener('click', () => {
    el.reportError.textContent = '';
    el.reportDialog.showModal();
  });
  el.reportCancel.addEventListener('click', () => el.reportDialog.close());
  el.reportForm.addEventListener('submit', (e) => { e.preventDefault(); submitReport(); });
  el.confirmCancel.addEventListener('click', () => el.confirmDialog.close());

  el.returnIdentityBtn.addEventListener('click', () => {
    showScreen('identity');
  });

  el.errorHomeBtn.addEventListener('click', () => {
    showScreen('identity');
  });

  updateIdentityDisplay();
  updateStatus();
})();
