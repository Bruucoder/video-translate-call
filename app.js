 (() => {
    'use strict';
  
    // ---------- ICE servers: Google STUN + free public OpenRelay TURN (no signup) ----------
    const ICE_SERVERS = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ];

    // ---------- DOM ----------
    const $ = (id) => document.getElementById(id);
    const setupScreen = $('setupScreen');
    const callScreen = $('callScreen');
    const langSelect = $('langSelect');
    const createRoomBtn = $('createRoomBtn');
    const joinRoomBtn = $('joinRoomBtn');
    const joinCodeInput = $('joinCodeInput');
    const roomInfo = $('roomInfo');
    const roomCodeDisplay = $('roomCodeDisplay');
    const copyLinkBtn = $('copyLinkBtn');
    const setupError = $('setupError');
  
    const remoteVideo = $('remoteVideo');
    const localVideo = $('localVideo');
    const tapToPlay = $('tapToPlay');
    const tapToPlayBtn = $('tapToPlayBtn');
    const captionBar = $('captionBar');
    const chatMessages = $('chatMessages');
    const chatForm = $('chatForm');
    const chatInput = $('chatInput');
    const micBtn = $('micBtn');
    const camBtn = $('camBtn');
    const captionsBtn = $('captionsBtn');
    const hangupBtn = $('hangupBtn');
    const callStatus = $('callStatus');

    // ---------- State ----------
    let myLang = 'en';
    let mySpeechLang = 'en-US';
    let peerLang = null; // learned from first message the other side sends
    let peer = null;
    let localStream = null;
    let mediaConn = null;
    let dataConn = null;
    let isHost = false;
    let roomCode = null;
    let recognition = null;
    let captionsOn = false;
    let captionsWanted = false; // survives restarts
    const translateCache = new Map();

    // ---------- Populate language select ----------
    for (const l of LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = `${l.code}|${l.speech}`;
      opt.textContent = l.name;
      if (l.code === 'en') opt.selected = true;
      langSelect.appendChild(opt);
    }

    function readSelectedLang() {
      const [code, speech] = langSelect.value.split('|');
      myLang = code;
      mySpeechLang = speech;
    }
    readSelectedLang();
    langSelect.addEventListener('change', readSelectedLang);

    // ---------- Helpers ----------
    function showError(msg) {
      setupError.textContent = msg;
      setupError.classList.remove('hidden');
    }
    function clearError() {
      setupError.classList.add('hidden');
      setupError.textContent = '';
    }
    function genCode() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let s = '';
      for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }
    function peerIdFor(code) { return 'xlate-room-' + code; }

    async function getMedia() {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 } },
        audio: true,
      });
      localVideo.srcObject = localStream;
    }
  
    function attachRemoteStream(stream) {
      remoteVideo.srcObject = stream;
      const playPromise = remoteVideo.play();
      if (playPromise && playPromise.catch) {
        playPromise.catch(() => { tapToPlay.classList.remove('hidden'); });
      }
    }
    tapToPlayBtn.addEventListener('click', () => {
      remoteVideo.play().catch(() => {});
      localVideo.play().catch(() => {});
      tapToPlay.classList.add('hidden');
    });

    function goToCallScreen() {
      setupScreen.classList.add('hidden');
      callScreen.classList.remove('hidden');
    }

    function setStatus(msg) { callStatus.textContent = msg; }

    // ---------- Translation (MyMemory, free, no key) ----------
    async function translateText(text, from, to) {
      if (!text || !text.trim()) return text;
      if (!from || !to || from === to) return text;
      const fromBase = from.split('-')[0];
      const toBase = to.split('-')[0];
      if (fromBase === toBase) return text;
      const key = fromBase + '|' + toBase + '|' + text;
      if (translateCache.has(key)) return translateCache.get(key);
      try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${fromBase}|${toBase}`;
        const res = await fetch(url);
        const data = await res.json();
        const translated = data && data.responseData && data.responseData.translatedText
          ? data.responseData.translatedText
          : text;
        translateCache.set(key, translated);
        return translated;
      } catch (e) {
        return text; // fall back to original on network/API failure
      }
    }
  
    // ---------- Data channel messaging ----------
    function sendData(obj) {
      if (dataConn && dataConn.open) dataConn.send(obj);
    }

    function setupDataConn(conn) {
      dataConn = conn;
      dataConn.on('open', () => setStatus('Connected'));
      dataConn.on('data', async (msg) => {
        if (!msg || !msg.type) return;
        if (msg.lang) peerLang = msg.lang;
        if (msg.type === 'chat') {
          const translated = await translateText(msg.text, msg.lang, myLang);
          renderChatBubble(translated, msg.text, false);
        } else if (msg.type === 'caption') {
          const translated = await translateText(msg.text, msg.lang, myLang);
          showCaption(translated);
        }
      });
      dataConn.on('close', () => setStatus('Call ended by other side'));
    }

    // ---------- Chat UI ----------
    function renderChatBubble(mainText, origText, isMe) {
      const div = document.createElement('div');
      div.className = 'chat-bubble' + (isMe ? ' me' : '');
      div.textContent = mainText;
      if (!isMe && origText && origText !== mainText) {
        const orig = document.createElement('span');
        orig.className = 'orig';
        orig.textContent = origText;
        div.appendChild(orig);
      }
      chatMessages.appendChild(div);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text) return;
      sendData({ type: 'chat', text, lang: myLang });
      renderChatBubble(text, null, true);
      chatInput.value = '';
    });

    // ---------- Captions UI ----------
    let captionTimeout = null;
    function showCaption(text) {
      captionBar.textContent = text;
      captionBar.classList.remove('hidden');
      clearTimeout(captionTimeout);
      captionTimeout = setTimeout(() => captionBar.classList.add('hidden'), 6000);
    }

    function startRecognition() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        setStatus('Live captions not supported in this browser');
        return;
      }
      recognition = new SR();
      recognition.lang = mySpeechLang;
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            const text = event.results[i][0].transcript.trim();
            if (text) sendData({ type: 'caption', text, lang: myLang });
          }
        }
      };
      recognition.onerror = () => { /* swallow; onend will attempt restart */ };
      recognition.onend = () => {
        if (captionsWanted) {
          try { recognition.start(); } catch (e) { setTimeout(() => { if (captionsWanted) startRecognition(); }, 500); }
        }
      };
      try { recognition.start(); } catch (e) { /* ignore double-start */ }
    }
  
    function stopRecognition() {
      captionsWanted = false;
      if (recognition) {
        try { recognition.stop(); } catch (e) {}
        recognition = null;
      }
    }

    captionsBtn.addEventListener('click', () => {
      captionsOn = !captionsOn;
      captionsBtn.classList.toggle('active', captionsOn);
      if (captionsOn) {
        captionsWanted = true;
        startRecognition();
      } else {
        stopRecognition();
        captionBar.classList.add('hidden');
      }
    });

    // ---------- Controls ----------
    let micOn = true, camOn = true;
    micBtn.addEventListener('click', () => {
      micOn = !micOn;
      localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
      micBtn.classList.toggle('off', !micOn);
    });
    camBtn.addEventListener('click', () => {
      camOn = !camOn;
      localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
      camBtn.classList.toggle('off', !camOn);
    });
    hangupBtn.addEventListener('click', () => hangUp('You ended the call'));

    function hangUp(reason) {
      stopRecognition();
      if (dataConn) { try { dataConn.close(); } catch (e) {} }
      if (mediaConn) { try { mediaConn.close(); } catch (e) {} }
      if (peer) { try { peer.destroy(); } catch (e) {} }
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      setStatus(reason || 'Call ended');
      setTimeout(() => window.location.href = window.location.pathname, 1200);
    }

    // ---------- Peer setup ----------
    function createPeer(id) {
      return new Peer(id, { config: { iceServers: ICE_SERVERS } });
    }

    async function startAsHost() {
      clearError();
      roomCode = genCode();
      try {
        await getMedia();
      } catch (e) {
        showError('Camera/mic permission is required to start a call.');
        return;
      }
      peer = createPeer(peerIdFor(roomCode));

      peer.on('open', () => {
        roomCodeDisplay.textContent = roomCode;
        roomInfo.classList.remove('hidden');
      });

      peer.on('call', (call) => {
        mediaConn = call;
        call.answer(localStream);
        call.on('stream', (remoteStream) => {
          goToCallScreen();
          attachRemoteStream(remoteStream);
          setStatus('Connected');
        });
        call.on('close', () => hangUp('Call ended by other side'));
      });

      peer.on('connection', (conn) => setupDataConn(conn));
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          peer.destroy();
          startAsHost(); // regenerate a fresh code
        } else {
          showError('Connection error: ' + err.type);
        } 
      });
    } 
    
    async function startAsJoiner(code) {
      clearError();
      roomCode = code;
      try {
        await getMedia();
      } catch (e) {
        showError('Camera/mic permission is required to join a call.');
        return;
      } 
      peer = createPeer(undefined);
      
      peer.on('open', () => {
        const hostId = peerIdFor(roomCode);
        const call = peer.call(hostId, localStream);
        mediaConn = call;
        call.on('stream', (remoteStream) => {
          goToCallScreen();
          attachRemoteStream(remoteStream);
          setStatus('Connected');
        });
        call.on('close', () => hangUp('Call ended by other side'));
        call.on('error', () => showError('Could not reach that room. Check the code and try again.'));
        
        const conn = peer.connect(hostId);
        setupDataConn(conn);
      });
      
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          showError('Room not found. Check the code and try again.');
        } else {
          showError('Connection error: ' + err.type);
        } 
      });
    } 
    
    // ---------- Wire up setup screen ----------
    createRoomBtn.addEventListener('click', () => {
      createRoomBtn.disabled = true;
      joinRoomBtn.disabled = true;
      startAsHost();
    });
    
    joinRoomBtn.addEventListener('click', () => {
      const code = joinCodeInput.value.trim().toUpperCase();
      if (!code) { showError('Enter a room code.'); return; }
      createRoomBtn.disabled = true;
      joinRoomBtn.disabled = true;
      startAsJoiner(code); 
    });
    
    copyLinkBtn.addEventListener('click', () => {
      const link = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
      navigator.clipboard.writeText(link).then(() => {
        copyLinkBtn.textContent = 'Copied!';
        setTimeout(() => (copyLinkBtn.textContent = 'Copy link'), 1500);
      }).catch(() => {});
    });
    
    // Prefill room code from a shared link (?room=CODE)
    (function prefillFromLink() {
      const params = new URLSearchParams(window.location.search);
      const room = params.get('room');
      if (room) joinCodeInput.value = room.toUpperCase();
    })();
  })();
