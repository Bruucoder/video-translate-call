// Metered TURN/STUN config.
// Paste your Metered username and credential into every TURN entry below.
window.EXTRA_ICE_SERVERS = [
  {
    urls: 'stun:stun.relay.metered.ca:80',
  },
  {
    urls: 'turn:global.relay.metered.ca:80',
    username: '1b182d7bf55720de0cdf0086',
    credential: 'LQDa/RErP182NFsG',
  },
  {
    urls: 'turn:global.relay.metered.ca:80?transport=tcp',
    username: '1b182d7bf55720de0cdf0086',
    credential: 'LQDa/RErP182NFsG',
  },
  {
    urls: 'turn:global.relay.metered.ca:443',
    username: '1b182d7bf55720de0cdf0086',
    credential: 'LQDa/RErP182NFsG',
  },
  {
    urls: 'turns:global.relay.metered.ca:443?transport=tcp',
    username: '1b182d7bf55720de0cdf0086',
    credential: 'LQDa/RErP182NFsG',
  },
];
