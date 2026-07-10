// ExpressTURN config.
// Paste your ExpressTURN username and credential into every TURN entry below.
// Relay-only mode confirms whether ExpressTURN can carry the call across networks.
window.FORCE_TURN_RELAY = true;
window.EXTRA_ICE_SERVERS = [
  {
    urls: 'turn:free.expressturn.com:3478',
    username: '000000002099033874',
    credential: 'WX2WpPP/P5UME4RXwzPTvu5hjpQ=',
  },
  {
    urls: 'turn:free.expressturn.com:3478?transport=tcp',
    username: '000000002099033874',
    credential: 'WX2WpPP/P5UME4RXwzPTvu5hjpQ=',
  },
  {
    urls: 'stun:free.expressturn.com:3478',
  },
];
