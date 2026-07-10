// ExpressTURN config.
// Paste your ExpressTURN username and credential into every TURN entry below.
window.EXTRA_ICE_SERVERS = [
  {
    urls: 'turn:free.expressturn.com:3478',
    username: '000000002099033874',
    credential: '000000002099033874',
  },
  {
    urls: 'turn:free.expressturn.com:3478?transport=tcp',
    username: '000000002099033874',
    credential: '000000002099033874',
  },
  {
    urls: 'stun:free.expressturn.com:3478',
  },
];
