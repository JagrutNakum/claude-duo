const { RelayClient } = require('./src/main/relay_client');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');

let cfg = {};
try {
  const cfgPath = path.join(os.homedir(), '.claude-duo', 'config.json');
  if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (e) {}

const ntfy = (cfg.channels_config && cfg.channels_config.ntfy) || {};
const PEER_NAME = cfg.peer_name || 'Teammate';
const LOCAL_NAME = cfg.user_name || 'You';
const TOPIC = ntfy.topic || 'claude-duo-shared';
const PASSPHRASE = cfg.e2ee_passphrase || 'claude-pro-shared-pass';
const DEVICE_ID = `${PEER_NAME.toLowerCase()}-remote-pc-sim`;

const client = new RelayClient({
  userName: PEER_NAME,
  passphrase: PASSPHRASE,
  topic: TOPIC,
  deviceId: DEVICE_ID
});

let peerState = {
  fiveHourUsedPct: 42,
  fiveHourUpdatedAt: Date.now(),
  fiveHourResetsAt: Math.floor(Date.now() / 1000) + 10800,
  sevenDayUsedPct: 28,
  local: {
    name: PEER_NAME,
    active: false,
    sharePct: 30,
    rollingQ: 180000
  },
  peer: {
    name: LOCAL_NAME,
    active: false,
    sharePct: 70,
    rollingQ: 420000
  },
  reservation: {
    holder: null,
    until: null,
    setAt: Date.now()
  }
};

function printMenu() {
  console.log('\n======================================================');
  console.log(`     CLAUDE-DUO TEAMMATE SIMULATOR (Node.js E2EE)`);
  console.log('======================================================');
  console.log(`Simulating Teammate: ${PEER_NAME} (Remote PC)`);
  console.log(`Your Name in App:   ${LOCAL_NAME}`);
  console.log(`Encrypted Topic:    ${TOPIC}`);
  console.log('Budget:             ntfy.sh allows 250 msgs/day; send sparingly');
  console.log('------------------------------------------------------');
  console.log(`  1. Send Ping to ${LOCAL_NAME} (Shows Windows Toast)`);
  console.log(`  2. Set ${PEER_NAME} ACTIVE (Card turns green "Prompting Now")`);
  console.log(`  3. Set ${PEER_NAME} IDLE (Card returns to "Idle")`);
  console.log(`  4. ${PEER_NAME} Reserves 20m Focus (Shows Focus Toast)`);
  console.log(`  5. ${PEER_NAME} Releases Focus`);
  console.log('  6. Simulate High Usage (Push 5h Limit to 88%)');
  console.log('  0. Exit');
  console.log('======================================================');
  process.stdout.write('Choose an option: ');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

printMenu();

rl.on('line', (line) => {
  const choice = line.trim();
  switch (choice) {
    case '1': {
      console.log(`\n[>] Sending ping from ${PEER_NAME} to ${LOCAL_NAME}...`);
      client.publishState({
        ...peerState,
        lastPing: {
          sender: PEER_NAME,
          message: `Hey ${LOCAL_NAME}! Are you running Claude Code right now?`,
          ts: Date.now()
        }
      });
      console.log('[OK] Ping sent! Check the Windows Toast on your screen.');
      break;
    }
    case '2': {
      console.log(`\n[>] Setting ${PEER_NAME} to ACTIVE...`);
      peerState.local.active = true;
      peerState.local.sharePct = 52;
      client.publishState(peerState);
      console.log(`[OK] Updated! Check your Claude-Duo window: ${PEER_NAME}'s card should show 'Prompting Now'.`);
      break;
    }
    case '3': {
      console.log(`\n[>] Setting ${PEER_NAME} to IDLE...`);
      peerState.local.active = false;
      client.publishState(peerState);
      console.log(`[OK] Updated! Check your Claude-Duo window: ${PEER_NAME}'s card should show 'Idle'.`);
      break;
    }
    case '4': {
      console.log(`\n[>] ${PEER_NAME} reserving 20m focus...`);
      const now = Date.now();
      peerState.reservation = {
        holder: PEER_NAME,
        until: now + (20 * 60 * 1000),
        setAt: now
      };
      client.publishState(peerState);
      console.log('[OK] Reservation sent! Check your Claude-Duo window and Windows toast.');
      break;
    }
    case '5': {
      console.log(`\n[>] ${PEER_NAME} releasing focus...`);
      peerState.reservation = {
        holder: null,
        until: null,
        setAt: Date.now()
      };
      client.publishState(peerState);
      console.log('[OK] Released! Check your Claude-Duo window.');
      break;
    }
    case '6': {
      console.log(`\n[>] Setting shared limit to 88% capacity with timestamp...`);
      peerState.fiveHourUsedPct = 88;
      peerState.fiveHourUpdatedAt = Date.now();
      client.publishState(peerState);
      console.log('[OK] Quota updated to 88%! The capacity bar should turn red.');
      break;
    }
    case '0': {
      console.log('Exiting simulator.');
      process.exit(0);
      break;
    }
    default:
      console.log('Invalid option.');
      break;
  }
  setTimeout(printMenu, 500);
});
