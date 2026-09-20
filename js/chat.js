(() => {
  'use strict';

  /* ------------------------------------------------------------------------ *
   * Security note: every piece of text that comes from the network (messages,
   * names) is written with textContent / createTextNode, never innerHTML, so
   * markup typed by a stranger is shown literally and can never run.
   * ------------------------------------------------------------------------ */

  const KEYS = { sid: 'passerby.sid', interest: 'passerby.interest', intent: 'passerby.intent' };
  const LABELS = {
    random: 'anyone', music: 'Music', gaming: 'Gaming', movies: 'Movies', technology: 'Technology',
    school: 'School', business: 'Business', relationships: 'Relationships', other: 'Other',
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
  const FATAL_TITLES = {
    banned: 'Access paused',
    too_many_connections: 'Too many open tabs',
    session_replaced: 'Opened in another tab',
  };

  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { /* ignore */ } },
    remove(k) { try { sessionStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    banner: $('banner'),
    screens: {
      connecting: $('screen-connecting'), matching: $('screen-matching'),
      chat: $('screen-chat'), error: $('screen-error'),
    },
    matchingSub: $('matching-sub'), noMatch: $('no-match'), noMatchText: $('no-match-text'),
    matchAnyone: $('match-anyone'), keepWaiting: $('keep-waiting'), cancel: $('cancel-btn'),
    name: $('stranger-name'), dot: $('status-dot'), statusText: $('status-text'),
    reportBtn: $('report-btn'), blockBtn: $('block-btn'), endBtn: $('end-btn'),
    messages: $('messages'), typing: $('typing'),
    composer: $('composer'), input: $('input'), sendBtn: $('send-btn'), counter: $('counter'),
    endedPanel: $('ended-panel'), endedTitle: $('ended-title'), endedText: $('ended-text'),
    findAnother: $('find-another'), returnHome: $('return-home'),
    errorTitle: $('error-title'), errorText: $('error-text'),
    reportDialog: $('report-dialog'), reportForm: $('report-form'), reportNote: $('report-note'),
    reportError: $('report-error'), reportCancel: $('report-cancel'), reportSubmit: $('report-submit'),
    confirmDialog: $('confirm-dialog'), confirmTitle: $('confirm-title'), confirmText: $('confirm-text'),
    confirmOk: $('confirm-ok'), confirmCancel: $('confirm-cancel'),
  };

  let socket = null; // assigned once the Socket.IO client is confirmed to be loaded

  const state = {
    connected: false,
    inChat: false,
    ended: false,
    you: '',
    stranger: '',
    partnerOnline: true,
    anyone: false, // user agreed to match with any topic
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

  const label = (interest) => LABELS[interest] || 'that topic';
  const timeText = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function showScreen(name) {
    for (const [key, node] of Object.entries(el.screens)) node.hidden = key !== name;
    const heading = el.screens[name].querySelector('h1');
    if (heading) heading.focus({ preventScroll: true });
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
    store.remove(KEYS.intent);
    hideBanner();
    el.errorTitle.textContent = FATAL_TITLES[code] || 'Connection problem';
    el.errorText.textContent = message || 'Something went wrong. Please try again in a moment.';
    showScreen('error');
    if (socket) socket.disconnect();
  }

  /* ------------------------------ messages ------------------------------ */

  function nearBottom() {
    const m = el.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 90;
  }
  function scrollToEnd() { el.messages.scrollTop = el.messages.scrollHeight; }

  function addSystem(text, warn) {
    const stick = nearBottom();
    const div = document.createElement('div');
    div.className = warn ? 'sys warn' : 'sys';
    // Keep "Stranger-12345" on one line (browsers otherwise break after the hyphen).
    text.split(/(Stranger-\d{5})/).forEach((part) => {
      if (/^Stranger-\d{5}$/.test(part)) {
        const name = document.createElement('span');
        name.className = 'nb';
        name.textContent = part;
        div.appendChild(name);
      } else if (part) {
        div.appendChild(document.createTextNode(part));
      }
    });
    el.messages.appendChild(div);
    if (stick) scrollToEnd();
  }

  function addMessage(m) {
    if (state.seen.has(m.id)) return; // history is re-sent after a reconnect
    state.seen.add(m.id);
    const stick = nearBottom() || m.self;
    const div = document.createElement('div');
    div.className = m.self ? 'msg me' : 'msg them';
    const body = document.createElement('span');
    body.textContent = m.text; // never innerHTML
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

  /* ------------------------------ status -------------------------------- */

  function updateStatus() {
    let dot = 'ok';
    let text = 'Connected';
    if (state.ended) { dot = 'ended'; text = 'Conversation ended'; }
    else if (!state.connected) { dot = 'off'; text = 'Reconnecting…'; }
    else if (!state.partnerOnline) { dot = 'warn'; text = 'Stranger is reconnecting…'; }
    el.dot.dataset.state = dot;
    el.statusText.textContent = text;

    const canSend = state.inChat && !state.ended && state.connected;
    el.sendBtn.disabled = !canSend;
    for (const b of [el.reportBtn, el.blockBtn, el.endBtn]) b.disabled = !state.inChat || state.ended || !state.connected;

    if (!state.connected && !state.fatal && state.inChat && !state.ended) {
      showBanner('Connection lost. Trying to reconnect…');
    } else if (state.connected && el.banner.textContent.startsWith('Connection lost')) {
      hideBanner();
    }
  }

  function setTyping(on) {
    clearTimeout(state.theirTypingTimer);
    el.typing.textContent = on ? `${state.stranger} is typing…` : '';
    if (on) state.theirTypingTimer = setTimeout(() => setTyping(false), 5000); // safety net if "stop" is lost
  }

  /* ---------------------------- conversation ---------------------------- */

  function enterChat({ you, stranger, interest, messages, partnerOnline }, resumed) {
    clearConversation();
    state.inChat = true;
    state.ended = false;
    state.blocked = false;
    state.you = you;
    state.stranger = stranger;
    state.partnerOnline = partnerOnline !== false;
    store.set(KEYS.intent, 'chat');

    el.name.textContent = stranger;
    el.endedPanel.hidden = true;
    el.composer.hidden = false;
    el.input.readOnly = false;
    showScreen('chat');

    if (resumed) {
      addSystem(`Reconnected. You are talking with ${stranger}.`);
      (messages || []).forEach(addMessage);
    } else {
      addSystem(`You are now connected with ${stranger}`);
      addSystem(interest ? `You both picked ${label(interest)}. You are ${you}.` : `You are ${you}.`);
    }
    scrollToEnd();
    updateStatus();
    if (!window.matchMedia('(pointer: coarse)').matches) el.input.focus(); // don't pop the keyboard on phones
  }

  function endChat(reason) {
    if (!state.inChat || state.ended) return;
    state.ended = true;
    state.inChat = false;
    state.partnerOnline = true;
    clearTimeout(state.typingStopTimer);
    state.myTyping = false;
    setTyping(false);
    store.set(KEYS.intent, 'ended');

    const mine = reason === 'you_ended';
    if (!mine) addSystem('The stranger has left the conversation.', true);
    el.endedText.textContent = mine
      ? (state.blocked
        ? "You blocked this stranger. You won't be matched again. The conversation has been deleted."
        : 'You ended the chat. The conversation has been deleted from the server.')
      : 'The conversation has been deleted from the server.';

    el.composer.hidden = true;
    el.endedPanel.hidden = false;
    updateStatus();
    el.endedTitle.focus({ preventScroll: true });
    scrollToEnd();
  }

  function showEndedFresh(text) {
    // Used when the page is reloaded after a conversation is already gone.
    clearConversation();
    state.inChat = true; // so endChat() runs its normal path
    state.ended = false;
    el.name.textContent = 'Stranger';
    showScreen('chat');
    endChat('partner_disconnected');
    el.messages.replaceChildren();
    el.endedText.textContent = text || 'This conversation has been deleted from the server.';
  }

  /* ------------------------------- matching ----------------------------- */

  function startSearch() {
    const interest = store.get(KEYS.interest) || 'random';
    store.set(KEYS.intent, 'find');
    el.endedPanel.hidden = true;
    el.noMatch.hidden = true;
    el.matchingSub.textContent = interest === 'random'
      ? 'Looking for anyone who is online.'
      : `Looking for someone into ${label(interest)}.`;
    showScreen('matching');

    socket.timeout(8000).emit('find_stranger', { interest, anyone: state.anyone }, (err, res) => {
      if (err) { showBanner("Couldn't reach the server. Retrying…", 4000); return; }
      if (res && res.ok) return; // "waiting" or "matched": match_found arrives as an event
      if (res && res.error === 'already_in_chat') return;
      const text = res && res.error === 'rate_limited'
        ? "You're searching too fast. Wait a moment, then try again."
        : 'Could not start a search. Please try again.';
      fatal('search_failed', text);
    });
  }

  function leaveHome() {
    store.remove(KEYS.intent);
    location.href = '/';
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
      if (socket.connected) socket.emit('typing_stop');
    }
  }

  function onInput() {
    autosize();
    updateCounter();
    if (!state.inChat || state.ended || !socket.connected) return;
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
    if (!socket.connected) { addSystem("You're offline. Your message wasn't sent.", true); return; }
    if ([...text].length > state.maxLen) { addSystem(SEND_ERRORS.too_long, true); return; }

    stopTyping();
    el.input.value = '';
    autosize();
    updateCounter();

    const restore = () => { if (!el.input.value) { el.input.value = text; autosize(); updateCounter(); } };
    socket.timeout(8000).emit('send_message', { text }, (err, res) => {
      if (err) { addSystem('Message not sent: no response from the server.', true); restore(); return; }
      if (res && res.ok) return; // it appears via receive_message
      const code = res && res.error;
      if (code === 'rate_limited') {
        const secs = Math.max(1, Math.ceil(((res && res.retryAfterMs) || 1000) / 1000));
        addSystem(`You're sending messages too fast. Try again in ${secs}s.`, true);
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
      if (err) { el.reportError.textContent = 'No response from the server. Please try again.'; return; }
      if (res && res.ok) {
        el.reportDialog.close();
        el.reportNote.value = '';
        addSystem('Report sent. Thank you. You can also block the stranger or end the chat.');
        return;
      }
      const map = {
        already_reported: 'You already reported this stranger.',
        rate_limited: 'You have sent too many reports. Please try again later.',
        not_in_chat: 'This conversation has already ended.',
      };
      el.reportError.textContent = map[res && res.error] || 'Could not send the report. Please try again.';
    });
  }

  /* -------------------------------- socket ------------------------------ */

  if (typeof io !== 'function') {
    state.fatal = true;
    el.errorTitle.textContent = 'Chat could not load';
    el.errorText.textContent = 'The connection library failed to load. Please reload the page.';
    showScreen('error');
    return;
  }

  socket = io({
    auth: (cb) => cb({ sid: store.get(KEYS.sid) || undefined }),
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
    showBanner("Can't reach the server. Retrying…");
  });

  socket.on('connection_error', ({ code, message } = {}) => {
    if (FATAL_TITLES[code]) { fatal(code, message); return; }
    if (code === 'server_restarting') { showBanner(message || 'The server is restarting…'); return; }
    if (state.inChat && !state.ended) addSystem(message || 'Something went wrong.', true);
    else showBanner(message || 'Something went wrong.', 5000);
  });

  socket.on('session', (s) => {
    if (!s || typeof s.sid !== 'string') return;
    store.set(KEYS.sid, s.sid);
    state.maxLen = (s.limits && s.limits.maxMessageLength) || 500;
    el.input.maxLength = state.maxLen;
    hideBanner();

    if (s.state === 'chatting' && s.chat) {
      enterChat({ ...s.chat }, true); // refresh or network drop: pick the conversation back up
      return;
    }
    const intent = store.get(KEYS.intent);
    if (state.inChat && !state.ended) { endChat('partner_disconnected'); return; } // it ended while we were away
    if (state.ended) { updateStatus(); return; }
    if (intent === 'find') { startSearch(); return; }
    if (intent === 'chat' || intent === 'ended') { showEndedFresh(); return; }
    location.replace('/'); // opened chat.html directly: nothing to do here
  });

  socket.on('match_found', (m) => {
    if (!m) return;
    state.anyone = false;
    enterChat(m, false);
  });

  socket.on('no_interest_match', ({ interest } = {}) => {
    if (el.screens.matching.hidden) return;
    el.noMatchText.textContent = `Nobody interested in ${label(interest)} is online right now. You can keep waiting, or talk to anyone.`;
    el.noMatch.hidden = false;
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
      addSystem(state.partnerOnline ? 'The stranger is back.' : 'The stranger lost connection. Waiting for them to come back…', !state.partnerOnline);
    }
    updateStatus();
  });

  socket.on('chat_ended', ({ reason } = {}) => endChat(reason));

  /* ------------------------------ UI wiring ----------------------------- */

  el.composer.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
  el.input.addEventListener('input', onInput);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  el.input.addEventListener('blur', stopTyping);

  el.cancel.addEventListener('click', () => {
    socket.emit('cancel_matching', () => {});
    leaveHome();
  });
  el.keepWaiting.addEventListener('click', () => { el.noMatch.hidden = true; });
  el.matchAnyone.addEventListener('click', () => {
    state.anyone = true;
    el.noMatch.hidden = true;
    el.matchingSub.textContent = 'Looking for anyone who is online.';
    startSearch();
  });

  el.endBtn.addEventListener('click', () => {
    confirmAction(
      { title: 'End this chat?', text: 'The conversation will be deleted for both of you and cannot be recovered.', okLabel: 'End chat' },
      () => {
        socket.timeout(8000).emit('end_chat', (err, res) => {
          if (err) { addSystem("Couldn't reach the server. Try again.", true); return; }
          if (res && res.ok && res.ended === false) endChat('partner_disconnected');
        });
      }
    );
  });

  el.blockBtn.addEventListener('click', () => {
    confirmAction(
      { title: 'Block this stranger?', text: "The chat will end and you won't be matched with them again.", okLabel: 'Block and end' },
      () => {
        state.blocked = true; // set before the reply so the "ended" text is right; chat_ended follows as an event
        socket.timeout(8000).emit('block_user', (err, res) => {
          if (err) { state.blocked = false; addSystem("Couldn't reach the server. Try again.", true); return; }
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

  el.findAnother.addEventListener('click', () => {
    clearConversation(); // the old transcript disappears from this screen too
    state.inChat = false;
    state.ended = false;
    state.anyone = false;
    startSearch();
  });
  el.returnHome.addEventListener('click', () => store.remove(KEYS.intent));

  el.input.maxLength = state.maxLen;
  updateStatus();
})();
