(() => {
  'use strict';

  // ---------- ICE servers: STUN + optional project TURN config ----------
  const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  const ROOM_TTL_MS = 1000 * 60 * 30; // invite links stay valid while the host is open, with stale cleanup after 30 minutes

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
  const cameraMenu = $('cameraMenu');
  const cameraOffBtn = $('cameraOffBtn');
  const frontCameraBtn = $('frontCameraBtn');
  const backCameraBtn = $('backCameraBtn');
  const captionsBtn = $('captionsBtn');
  const hangupBtn = $('hangupBtn');
  const callStatus = $('callStatus');

  // ---------- State ----------
  let myLang = 'en';
  let mySpeechLang = 'en-US';
  let peerLang = null; // learned from first message the other side sends
  let localStream = null;
  let remoteStream = null;
  let pc = null;
  let dataChannel = null;
  let isHost = false;
  let roomCode = null;
  let db = null;
  let roomRef = null;
  let unsubscribeFns = [];
  let pendingRemoteCandidates = [];
  let recognition = null;
  let captionsOn = false;
  let captionsWanted = false; // survives restarts
  let callEnded = false;
  let micOn = true;
  let camOn = true;
  let currentFacingMode = 'user';
  let cameraSwitching = false;
  let userUnlockedMedia = false;
  let localCandidateCount = 0;
  let remoteCandidateCount = 0;
  let localRelayCandidateCount = 0;
  let remoteRelayCandidateCount = 0;
  let connectionWatchdog = null;
  let iceRestartAttempts = 0;
  let lastOfferSdp = null;
  let lastAnswerSdp = null;
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
  function log(step, detail) {
    if (detail !== undefined) {
      console.log(`[call] ${step}`, detail);
    } else {
      console.log(`[call] ${step}`);
    }
  }

  function showError(msg) {
    log('error', msg);
    setupError.textContent = msg;
    setupError.classList.remove('hidden');
    createRoomBtn.disabled = false;
    joinRoomBtn.disabled = false;
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

  function normalizeCode(code) {
    return (code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  function setStatus(msg) {
    callStatus.textContent = msg || '';
    if (msg) log('status: ' + msg);
  }

  function goToCallScreen(status) {
    setupScreen.classList.add('hidden');
    callScreen.classList.remove('hidden');
    if (status) setStatus(status);
    playLocalVideo();
  }

  function configureVideoElements() {
    for (const video of [localVideo, remoteVideo]) {
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.autoplay = true;
    }
    localVideo.muted = true;
  }
  configureVideoElements();

  function videoConstraints(facingMode = currentFacingMode) {
    return {
      facingMode: { ideal: facingMode },
      width: { ideal: 640 },
      height: { ideal: 480 },
    };
  }

  function updateCameraUi() {
    localVideo.classList.toggle('selfie-preview', currentFacingMode === 'user');
    camBtn.classList.toggle('off', !camOn);
    if (cameraOffBtn) cameraOffBtn.classList.toggle('active', !camOn);
    if (frontCameraBtn) frontCameraBtn.classList.toggle('active', camOn && currentFacingMode === 'user');
    if (backCameraBtn) backCameraBtn.classList.toggle('active', camOn && currentFacingMode === 'environment');
  }

  function showCameraMenu(show) {
    cameraMenu.classList.toggle('hidden', !show);
    updateCameraUi();
  }

  function iceServers() {
    const extraServers = Array.isArray(window.EXTRA_ICE_SERVERS) ? window.EXTRA_ICE_SERVERS : [];
    const servers = [...DEFAULT_ICE_SERVERS, ...extraServers];
    log('ICE servers configured', servers.map((server) => server.urls));
    return servers;
  }

  function firebaseConfig() {
    return window.firebaseConfig || window.FIREBASE_CONFIG || null;
  }

  function initFirebase() {
    if (!window.firebase || !window.firebase.database) {
      throw new Error('Firebase SDK is not loaded. Add Firebase App and Realtime Database scripts before app.js.');
    }

    if (!window.firebase.apps.length) {
      const config = firebaseConfig();
      const requiredFields = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];
      const missingFields = requiredFields.filter((field) => !config || !String(config[field] || '').trim());
      if (missingFields.length) {
        throw new Error(`Firebase config is missing: ${missingFields.join(', ')}. Fill firebase-config.js with your Firebase web app config.`);
      }

      window.firebase.initializeApp(config);
      log('Firebase initialized');
    }

    db = window.firebase.database();
    return db;
  }

  async function createUniqueRoomRef() {
    for (let i = 0; i < 8; i++) {
      const code = genCode();
      const candidateRef = db.ref(`rooms/${code}`);
      const result = await candidateRef.transaction((room) => {
        if (room) return;
        return {
          createdAt: window.firebase.database.ServerValue.TIMESTAMP,
          expiresAt: Date.now() + ROOM_TTL_MS,
          hostLang: myLang,
        };
      });

      if (result.committed) {
        roomCode = code;
        return candidateRef;
      }
    }
    throw new Error('Could not create a unique room. Please try again.');
  }

  function addDbListener(ref, eventName, handler) {
    const cancelHandler = (err) => {
      log(`Firebase listener failed for ${ref.toString()}`, err);
      setStatus('Firebase signaling permission error');
    };
    ref.on(eventName, handler, cancelHandler);
    unsubscribeFns.push(() => ref.off(eventName, handler));
  }

  function clearDbListeners() {
    unsubscribeFns.forEach((unsubscribe) => {
      try { unsubscribe(); } catch (e) {}
    });
    unsubscribeFns = [];
  }

  function startConnectionWatchdog(label) {
    clearTimeout(connectionWatchdog);
    connectionWatchdog = setTimeout(() => {
      if (!pc || callEnded) return;
      const connected = pc.connectionState === 'connected'
        || pc.iceConnectionState === 'connected'
        || pc.iceConnectionState === 'completed';
      if (connected) return;

      log(`${label} still connecting`, {
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        localCandidates: localCandidateCount,
        remoteCandidates: remoteCandidateCount,
      });

      if (!remoteCandidateCount) {
        setStatus('Still connecting: no remote ICE candidates received');
      } else if (!localCandidateCount) {
        setStatus('Still connecting: no local ICE candidates sent');
      } else {
        setStatus('Still connecting. Try Wi-Fi or a different network.');
      }
    }, 15000);
  }

  function stopConnectionWatchdog() {
    clearTimeout(connectionWatchdog);
    connectionWatchdog = null;
  }

  function connectionFailureMessage() {
    if (!remoteCandidateCount) return 'Connection failed: no remote ICE candidates';
    if (!localCandidateCount) return 'Connection failed: no local ICE candidates';
    if (!localRelayCandidateCount || !remoteRelayCandidateCount) {
      return `Connection failed: TURN relay not available (${localRelayCandidateCount}/${remoteRelayCandidateCount})`;
    }
    return `Connection failed: ICE blocked (${localCandidateCount}/${remoteCandidateCount})`;
  }

  function candidateType(candidateData) {
    const candidate = typeof candidateData === 'string'
      ? candidateData
      : candidateData && candidateData.candidate;
    const match = candidate && candidate.match(/ typ ([a-z0-9]+)/i);
    return match ? match[1].toLowerCase() : 'unknown';
  }

  async function restartIceIfPossible() {
    if (!pc || !roomRef || callEnded || !isHost || iceRestartAttempts >= 1) return;
    iceRestartAttempts += 1;

    try {
      setStatus('Connection failed. Retrying...');
      log('starting ICE restart');
      if (pc.restartIce) pc.restartIce();
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await roomRef.child('offer').set({
        type: offer.type,
        sdp: offer.sdp,
        lang: myLang,
        restart: iceRestartAttempts,
      });
      startConnectionWatchdog('host ICE restart');
      log('ICE restart offer published');
    } catch (err) {
      log('ICE restart failed', err);
      setStatus(connectionFailureMessage());
    }
  }

  async function getMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera/mic access is not supported in this browser.');
    }

    setStatus('Requesting camera and microphone...');
    log('requesting local media');
    localStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints(),
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    localVideo.srcObject = localStream;
    updateCameraUi();
    playLocalVideo();
    log('local media ready', {
      audioTracks: localStream.getAudioTracks().length,
      videoTracks: localStream.getVideoTracks().length,
    });
  }

  function playLocalVideo() {
    safePlayVideo(localVideo, 'local video').catch(() => {});
  }

  async function safePlayVideo(video, label) {
    if (!video || !video.srcObject) return true;

    try {
      const playPromise = video.play();
      if (playPromise && playPromise.then) await playPromise;
      log(`${label} playback started`);
      return true;
    } catch (err) {
      log(`${label} playback blocked`, err && err.message ? err.message : err);
      return false;
    }
  }

  function remoteHasTracks() {
    return remoteStream && remoteStream.getTracks().length > 0;
  }

  async function playRemoteVideo() {
    if (!remoteHasTracks()) return true;
    const played = await safePlayVideo(remoteVideo, 'remote video');
    if (played) {
      tapToPlay.classList.add('hidden');
    } else {
      tapToPlay.classList.remove('hidden');
      setStatus('Tap to enable audio/video');
    }
    return played;
  }

  function attachRemoteStream(stream, shouldPlay = false) {
    if (remoteVideo.srcObject !== stream) remoteVideo.srcObject = stream;
    if (shouldPlay) playRemoteVideo();
  }

  async function unlockMediaFromTap(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    userUnlockedMedia = true;
    setStatus('Starting audio/video...');
    await safePlayVideo(localVideo, 'local video');
    const remotePlayed = await playRemoteVideo();
    if (remotePlayed) setStatus(dataChannel && dataChannel.readyState === 'open' ? 'Connected' : 'Connecting chat...');
  }

  tapToPlayBtn.addEventListener('click', unlockMediaFromTap);
  tapToPlayBtn.addEventListener('touchend', unlockMediaFromTap, { passive: false });
  tapToPlayBtn.addEventListener('pointerup', unlockMediaFromTap);

  tapToPlay.addEventListener('click', (event) => {
    if (event.target === tapToPlay) unlockMediaFromTap(event);
  });

  function createPeerConnection(role) {
    setStatus('Creating WebRTC connection...');
    log(`creating RTCPeerConnection as ${role}`);

    pc = new RTCPeerConnection({
      iceServers: iceServers(),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;

    if (localStream) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream);
        log(`added local ${track.kind} track`);
      });
    }

    pc.ontrack = (event) => {
      log('remote track received', event.track.kind);
      const tracks = event.streams && event.streams[0]
        ? event.streams[0].getTracks()
        : [event.track];
      tracks.forEach((track) => {
        if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
          remoteStream.addTrack(track);
        }
      });
      attachRemoteStream(remoteStream, true);
      if (userUnlockedMedia) playRemoteVideo();
      if (callScreen.classList.contains('hidden')) {
        goToCallScreen('Remote media connected');
      } else {
        setStatus('Remote media connected');
      }
    };

    pc.onicecandidate = async (event) => {
      if (!event.candidate || !roomRef) {
        if (!event.candidate) log('finished gathering ICE candidates');
        return;
      }

      const path = role === 'host' ? 'hostCandidates' : 'joinerCandidates';
      try {
        const candidateJson = event.candidate.toJSON();
        const type = candidateType(candidateJson);
        if (type === 'relay') localRelayCandidateCount += 1;
        log(`local ICE candidate (${type})`);
        await roomRef.child(path).push(candidateJson);
        localCandidateCount += 1;
        log(`sent ${path} ICE candidate`);
      } catch (err) {
        log('failed to send ICE candidate', err);
        setStatus('Could not send ICE candidate');
      }
    };

    pc.onicecandidateerror = (event) => {
      log('ICE candidate error', {
        url: event.url,
        errorCode: event.errorCode,
        errorText: event.errorText,
      });
    };

    pc.onicegatheringstatechange = () => {
      setStatus(`ICE gathering: ${pc.iceGatheringState}`);
    };

    pc.oniceconnectionstatechange = () => {
      log('ICE connection state: ' + pc.iceConnectionState);
      if (pc.iceConnectionState === 'checking') setStatus('Connecting media...');
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        stopConnectionWatchdog();
        setStatus('Connected');
      }
      if (pc.iceConnectionState === 'failed') {
        setStatus(connectionFailureMessage());
        restartIceIfPossible();
      }
      if (pc.iceConnectionState === 'disconnected') setStatus('Connection interrupted...');
    };

    pc.onconnectionstatechange = () => {
      log('Peer connection state: ' + pc.connectionState);
      if (pc.connectionState === 'connected') {
        stopConnectionWatchdog();
        setStatus('Connected');
      }
      if (pc.connectionState === 'failed') {
        setStatus(connectionFailureMessage());
        restartIceIfPossible();
      }
      if (pc.connectionState === 'closed' && !callEnded) setStatus('Call ended');
    };

    pc.ondatachannel = (event) => {
      log('data channel received');
      setupDataChannel(event.channel);
    };

    return pc;
  }

  async function addRemoteCandidate(candidateData) {
    if (!candidateData || !pc) return;

    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      pendingRemoteCandidates.push(candidateData);
      log('queued remote ICE candidate');
      return;
    }

    try {
      const type = candidateType(candidateData);
      await pc.addIceCandidate(new RTCIceCandidate(candidateData));
      remoteCandidateCount += 1;
      if (type === 'relay') remoteRelayCandidateCount += 1;
      log(`added remote ICE candidate (${type})`);
    } catch (err) {
      log('failed to add remote ICE candidate', err);
      setStatus('Could not add remote ICE candidate');
    }
  }

  async function flushRemoteCandidates() {
    const candidates = pendingRemoteCandidates.splice(0);
    for (const candidate of candidates) {
      await addRemoteCandidate(candidate);
    }
  }

  function listenForRemoteCandidates(path) {
    addDbListener(roomRef.child(path), 'child_added', (snapshot) => {
      addRemoteCandidate(snapshot.val());
    });
  }

  function listenForOfferUpdates() {
    addDbListener(roomRef.child('offer'), 'value', async (snapshot) => {
      const offer = snapshot.val();
      if (!offer || !pc || offer.sdp === lastOfferSdp) return;

      try {
        lastOfferSdp = offer.sdp;
        setStatus(offer.restart ? 'Retry offer received...' : 'Offer received...');
        peerLang = offer.lang || peerLang;
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        log(offer.restart ? 'restart offer applied' : 'offer applied');
        await flushRemoteCandidates();

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await roomRef.child('answer').set({
          type: answer.type,
          sdp: answer.sdp,
          lang: myLang,
          restart: offer.restart || 0,
        });
        setStatus(offer.restart ? 'Retry answer sent. Connecting...' : 'Answer sent. Connecting...');
        log(offer.restart ? 'restart answer published' : 'answer published');
        startConnectionWatchdog('joiner');
      } catch (err) {
        log('failed to handle offer', err);
        setStatus('Could not process offer');
      }
    });
  }

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
      log('translation failed; using original text', e);
      return text; // fall back to original on network/API failure
    }
  }

  // ---------- Data channel messaging ----------
  function sendData(obj) {
    if (!dataChannel || dataChannel.readyState !== 'open') {
      setStatus('Chat is connecting...');
      log('data channel not open; message skipped', obj && obj.type);
      return false;
    }

    try {
      dataChannel.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      log('failed to send data channel message', err);
      return false;
    }
  }

  function setupDataChannel(channel) {
    dataChannel = channel;
    dataChannel.onopen = () => {
      log('data channel open');
      setStatus('Connected');
      sendData({ type: 'hello', lang: myLang });
    };
    dataChannel.onmessage = async (event) => {
      let msg;
      try {
        msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch (err) {
        log('ignored invalid data channel message', event.data);
        return;
      }

      if (!msg || !msg.type) return;
      if (msg.lang) peerLang = msg.lang;

      if (msg.type === 'hello') {
        log('peer language learned', peerLang);
      } else if (msg.type === 'chat') {
        const translated = await translateText(msg.text, msg.lang, myLang);
        renderChatBubble(translated, msg.text, false);
      } else if (msg.type === 'caption') {
        const translated = await translateText(msg.text, msg.lang, myLang);
        showCaption(translated);
      } else if (msg.type === 'hangup') {
        hangUp('Call ended by other side', { notifyPeer: false, redirect: true });
      }
    };
    dataChannel.onclose = () => {
      log('data channel closed');
      if (!callEnded) setStatus('Chat disconnected');
    };
    dataChannel.onerror = (err) => {
      log('data channel error', err);
      setStatus('Chat connection error');
    };
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
    if (sendData({ type: 'chat', text, lang: myLang })) {
      renderChatBubble(text, null, true);
      chatInput.value = '';
    }
  });

  callScreen.addEventListener('click', (event) => {
    if (callScreen.classList.contains('hidden')) return;
    if (event.target.closest('.chat-overlay, .controls, .camera-menu, .local-video, .tap-to-play')) return;

    showCameraMenu(false);
    callScreen.classList.toggle('chat-hidden');
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
    recognition.onerror = (err) => {
      log('speech recognition error', err);
    };
    recognition.onend = () => {
      if (captionsWanted) {
        setTimeout(() => {
          if (captionsWanted) startRecognition();
        }, 500);
      }
    };
    try {
      recognition.start();
      setStatus('Captions listening...');
    } catch (e) {
      log('speech recognition start ignored', e);
    }
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
      setStatus('Captions off');
    }
  });

  // ---------- Controls ----------
  micBtn.addEventListener('click', () => {
    micOn = !micOn;
    const tracks = localStream ? localStream.getAudioTracks() : [];
    tracks.forEach((t) => (t.enabled = micOn));
    micBtn.classList.toggle('off', !micOn);
    setStatus(micOn ? 'Microphone on' : 'Microphone muted');
  });

  async function setCameraEnabled(enabled) {
    camOn = enabled;
    const tracks = localStream ? localStream.getVideoTracks() : [];
    tracks.forEach((t) => (t.enabled = enabled));
    updateCameraUi();
    setStatus(enabled ? 'Camera on' : 'Camera off');
  }

  async function switchCamera(facingMode) {
    if (cameraSwitching) return;
    cameraSwitching = true;
    showCameraMenu(false);
    setStatus(facingMode === 'environment' ? 'Switching to back camera...' : 'Switching to front camera...');

    const previousFacingMode = currentFacingMode;
    const oldVideoTracks = localStream ? localStream.getVideoTracks() : [];
    oldVideoTracks.forEach((track) => {
      try { track.stop(); } catch (e) {}
      if (localStream) localStream.removeTrack(track);
    });

    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints(facingMode),
        audio: false,
      });
      const [newTrack] = videoStream.getVideoTracks();
      if (!newTrack) throw new Error('No video track returned');

      currentFacingMode = facingMode;
      camOn = true;
      localStream.addTrack(newTrack);
      localVideo.srcObject = localStream;

      const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);

      updateCameraUi();
      playLocalVideo();
      setStatus(facingMode === 'environment' ? 'Back camera on' : 'Front camera on');
    } catch (err) {
      log('camera switch failed', err);
      currentFacingMode = previousFacingMode;
      setStatus('Could not switch camera');
      try {
        const recoveryStream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints(previousFacingMode),
          audio: false,
        });
        const [recoveryTrack] = recoveryStream.getVideoTracks();
        if (recoveryTrack && localStream) {
          localStream.addTrack(recoveryTrack);
          localVideo.srcObject = localStream;
          const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender) await sender.replaceTrack(recoveryTrack);
        }
      } catch (recoveryErr) {
        log('camera recovery failed', recoveryErr);
      }
      updateCameraUi();
    } finally {
      cameraSwitching = false;
    }
  }

  camBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    showCameraMenu(cameraMenu.classList.contains('hidden'));
  });
  cameraOffBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    showCameraMenu(false);
    setCameraEnabled(false);
  });
  frontCameraBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    switchCamera('user');
  });
  backCameraBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    switchCamera('environment');
  });

  hangupBtn.addEventListener('click', () => hangUp('You ended the call'));

  function hangUp(reason, options = {}) {
    const { notifyPeer = true, redirect = true } = options;
    if (callEnded) return;
    callEnded = true;
    log('hanging up', reason);

    stopConnectionWatchdog();
    if (notifyPeer) sendData({ type: 'hangup', lang: myLang });
    stopRecognition();
    clearDbListeners();

    if (dataChannel) {
      try { dataChannel.close(); } catch (e) {}
      dataChannel = null;
    }

    if (pc) {
      try { pc.getSenders().forEach((sender) => sender.track && sender.track.stop()); } catch (e) {}
      try { pc.close(); } catch (e) {}
      pc = null;
    }

    if (localStream) {
      localStream.getTracks().forEach((t) => {
        try { t.stop(); } catch (e) {}
      });
      localStream = null;
    }

    if (remoteStream) {
      remoteStream.getTracks().forEach((t) => {
        try { t.stop(); } catch (e) {}
      });
      remoteStream = null;
    }

    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;

    if (isHost && roomRef) {
      roomRef.remove().catch((err) => log('room cleanup failed', err));
    }

    setStatus(reason || 'Call ended');
    if (redirect) {
      setTimeout(() => {
        window.location.href = window.location.pathname;
      }, 1200);
    }
  }

  // ---------- WebRTC + Firebase signaling ----------
  async function startAsHost() {
    clearError();
    isHost = true;
    callEnded = false;
    pendingRemoteCandidates = [];
    localCandidateCount = 0;
    remoteCandidateCount = 0;
    localRelayCandidateCount = 0;
    remoteRelayCandidateCount = 0;
    iceRestartAttempts = 0;
    lastOfferSdp = null;
    lastAnswerSdp = null;

    try {
      initFirebase();
      await getMedia();
      roomRef = await createUniqueRoomRef();
      await roomRef.onDisconnect().remove();

      roomCodeDisplay.textContent = roomCode;
      roomInfo.classList.remove('hidden');
      setStatus('Room created. Waiting for guest...');
      log('room created', roomCode);

      createPeerConnection('host');
      dataChannel = pc.createDataChannel('translated-chat', { ordered: true });
      setupDataChannel(dataChannel);
      listenForRemoteCandidates('joinerCandidates');

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await pc.setLocalDescription(offer);
      await roomRef.child('offer').set({
        type: offer.type,
        sdp: offer.sdp,
        lang: myLang,
      });
      setStatus('Offer published. Waiting for answer...');
      log('offer published');

      addDbListener(roomRef.child('answer'), 'value', async (snapshot) => {
        const answer = snapshot.val();
        if (!answer || !pc || answer.sdp === lastAnswerSdp) return;

        try {
          lastAnswerSdp = answer.sdp;
          setStatus(answer.restart ? 'Retry answer received. Connecting...' : 'Answer received. Connecting...');
          if (callScreen.classList.contains('hidden')) goToCallScreen('Answer received. Connecting...');
          peerLang = answer.lang || peerLang;
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          log(answer.restart ? 'restart answer applied' : 'answer applied');
          await flushRemoteCandidates();
          startConnectionWatchdog('host');
        } catch (err) {
          log('failed to apply answer', err);
          setStatus('Could not connect answer');
        }
      });
    } catch (err) {
      showError(err.message || 'Could not create room.');
      hangUp('Call setup failed', { notifyPeer: false, redirect: false });
    }
  }

  async function startAsJoiner(code) {
    clearError();
    isHost = false;
    callEnded = false;
    roomCode = normalizeCode(code);
    pendingRemoteCandidates = [];
    localCandidateCount = 0;
    remoteCandidateCount = 0;
    localRelayCandidateCount = 0;
    remoteRelayCandidateCount = 0;
    iceRestartAttempts = 0;
    lastOfferSdp = null;
    lastAnswerSdp = null;

    if (!roomCode) {
      showError('Enter a room code.');
      return;
    }

    try {
      initFirebase();
      await getMedia();
      roomRef = db.ref(`rooms/${roomCode}`);
      const snapshot = await roomRef.once('value');
      const room = snapshot.val();

      if (!room || !room.offer) {
        throw new Error('Room not found. Check the code and try again.');
      }

      if (room.expiresAt && room.expiresAt < Date.now()) {
        throw new Error('This room expired. Ask the host for a new link.');
      }

      await roomRef.child('joiner').set({
        joinedAt: window.firebase.database.ServerValue.TIMESTAMP,
        lang: myLang,
      });
      await roomRef.child('joiner').onDisconnect().remove();

      goToCallScreen('Joining room...');
      createPeerConnection('joiner');
      listenForRemoteCandidates('hostCandidates');
      listenForOfferUpdates();
    } catch (err) {
      showError(err.message || 'Could not join room.');
      hangUp('Call setup failed', { notifyPeer: false, redirect: false });
    }
  }

  // ---------- Wire up setup screen ----------
  createRoomBtn.addEventListener('click', () => {
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    startAsHost();
  });

  joinRoomBtn.addEventListener('click', () => {
    const code = normalizeCode(joinCodeInput.value || roomCode);
    if (!code) { showError('Enter a room code.'); return; }
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    startAsJoiner(code);
  });

  joinCodeInput.addEventListener('input', () => {
    joinCodeInput.value = normalizeCode(joinCodeInput.value);
  });

  copyLinkBtn.addEventListener('click', () => {
    const link = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
    const markCopied = () => {
      copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => (copyLinkBtn.textContent = 'Copy link'), 1500);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(markCopied).catch(() => {});
    } else {
      window.prompt('Copy this invite link:', link);
      markCopied();
    }
  });

  window.addEventListener('beforeunload', () => {
    if (!callEnded && dataChannel && dataChannel.readyState === 'open') {
      sendData({ type: 'hangup', lang: myLang });
    }
    if (isHost && roomRef) {
      try { roomRef.remove(); } catch (e) {}
    }
  });

  // Prefill room code from a shared link (?room=CODE)
  (function prefillFromLink() {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room) {
      roomCode = normalizeCode(room);
      joinCodeInput.value = roomCode;
      setupScreen.classList.add('invite-mode');
      joinRoomBtn.textContent = 'Join call';
    }
  })();
})();
