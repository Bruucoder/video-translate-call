// ExpressTURN config.
// Paste your ExpressTURN username and credential into every TURN entry below.
// Relay-only mode confirms whether ExpressTURN can carry the call across networks.
window.FORCE_TURN_RELAY = true;
window.EXTRA_ICE_SERVERS = [
  {
    urls: 'turn:global.expressturn.com:3478',
    username: '000000002099035391',
    credential: 'amKEQZxwjkIpCnEuYDiKyLPLd9I=',
  },
  {
    urls: 'turn:global.expressturn.com:3478?transport=tcp',
    username: '000000002099035391',
    credential: 'amKEQZxwjkIpCnEuYDiKyLPLd9I=',
  },
  {
    urls: 'turn:relay1.expressturn.com:80?transport=tcp',
    username: '000000002099035391',
    credential: 'amKEQZxwjkIpCnEuYDiKyLPLd9I=',
  },
  {
    urls: 'turn:relay1.expressturn.com:443?transport=tcp',
    username: '000000002099035391',
    credential: 'amKEQZxwjkIpCnEuYDiKyLPLd9I=',
  },
  {
    urls: 'turns:relay1.expressturn.com:443?transport=tcp',
    username: '000000002099035391',
    credential: 'amKEQZxwjkIpCnEuYDiKyLPLd9I=',
  },
  {
    urls: 'turn:relay2.expressturn.com:3478',
    username: '000000002099035391',
    credential: 'amKEQZxwjkIpCnEuYDiKyLPLd9I=',
  },
  {
    urls: 'stun:global.expressturn.com:3478',
  },
];
