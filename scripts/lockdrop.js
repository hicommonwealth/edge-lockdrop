require('dotenv').config();
const program = require('commander');
const Web3 = require('web3');
const { toBN, fromWei } = require('web3').utils;
const HDWalletProvider = require("truffle-hdwallet-provider");
const EthereumTx = require('ethereumjs-tx')
const bs58 = require('bs58');
const fs = require('fs');
const ldHelpers = require("../helpers/lockdropHelper.js");

program
  .version('0.1.0')
  .option('-b, --balance', 'Get the total balance across all locks')
  .option('-l, --lock', 'Lock ETH with the lockdrop')
  .option('-s, --signal <contractAddress>', 'Signal a contract balance in the lockdrop')
  .option('-n, --nonce <nonce>', 'Transaction nonce that created a specific contract address')
  .option('-u, --unlock <contractAddress>', 'Unlock ETH from a specific lock contract')
  .option('-r, --remoteUrl <url>', 'The remote URL of an Ethereum node (defaults to localhost:8545)')
  .option('--unlockAll', 'Unlock all locks from the locally stored Ethereum address')
  .option('--lockdropContractAddress <addr>', 'The Ethereum address for the target Lockdrop (THIS IS A LOCKDROP CONTRACT)')
  .option('--allocation', 'Get the allocation for the current set of lockers')
  .option('--ending', 'Get the remaining time of the lockdrop')
  .option('--lockLength <length>', 'The desired lock length - (3, 6, or 12)')
  .option('--lockValue <value>', 'The amount of Ether to lock')
  .option('--edgeAddress <address>', 'Edgeware ED25519 Base58 encoded address')
  .option('--isValidator', 'A boolean flag indicating intent to be a validator')
  .option('--locksForAddress <userAddress>', 'Returns the history of lock contracts for a participant in the lockdrop')
  .parse(process.argv);

function getWeb3(remoteUrl) {
  let provider;
  if (ETH_PRIVATE_KEY) {
    provider = new HDWalletProvider(ETH_PRIVATE_KEY, remoteUrl);
  } else {
    provider = new Web3.providers.HttpProvider(remoteUrl);
  }

  const web3 = new Web3(provider);
  return web3;
}

async function getCurrentTimestamp(remoteUrl=LOCALHOST_URL) {
  const web3 = getWeb3(remoteUrl);
  const block = await web3.eth.getBlock("latest");
  return block.timestamp;
}

async function getLockdropAllocation(lockdropContractAddress, remoteUrl=LOCALHOST_URL, totalAllocation='5000000000000000000000000') {
  console.log('Fetching Lockdrop locked locks...');
  console.log("");
  const web3 = getWeb3(remoteUrl);
  const contract = new web3.eth.Contract(LOCKDROP_JSON.abi, lockdropContractAddress);
  const { locks, totalEffectiveETHLocked } = await ldHelpers.calculateEffectiveLocks(contract);
  const { signals, totalEffectiveETHSignaled } = await ldHelpers.calculateEffectiveSignals(web3, contract);
  const totalEffectiveETH = totalEffectiveETHLocked.add(totalEffectiveETHSignaled);
  let json = await ldHelpers.getEdgewareBalanceObjects(locks, signals, totalAllocation, totalEffectiveETH);
  return json;
};

async function lock(lockdropContractAddress, length, value, edgeAddress, isValidator=false, remoteUrl=LOCALHOST_URL) {
  // Ensure lock lengths are valid from the CLI
  if (['3','6','12'].indexOf(length) === -1) throw new Error('Invalid length, must pass in 3, 6, 12');
  console.log(`locking ${value} ether into Lockdrop contract for ${length} months. Receiver: ${edgeAddress}, Validator: ${isValidator}`);
  console.log("");
  const web3 = getWeb3(remoteUrl);
  const contract = new web3.eth.Contract(LOCKDROP_JSON.abi, lockdropContractAddress);
  // Format lock length values as their respective enum values for the lockdrop contract
  let lockLength = (length == "3") ? 0 : (length == "6") ? 1 : 2;
  // Grab account's transaction nonce for tx params
  let txNonce = await web3.eth.getTransactionCount(web3.currentProvider.addresses[0]);
  // Convert ETH value submitted into WEI
  value = web3.utils.toWei(value, 'ether');
  // Create tx params for lock function
  const tx = new EthereumTx({
    nonce: txNonce,
    from: web3.currentProvider.addresses[0],
    to: lockdropContractAddress,
    gas: 150000,
    data: contract.methods.lock(lockLength, edgeAddress, isValidator).encodeABI(),
    value: toBN(value),
  });

  try {
    // Sign the tx and send it
    tx.sign(Buffer.from(ETH_PRIVATE_KEY, 'hex'));
    var raw = '0x' + tx.serialize().toString('hex');
    const txReceipt = await web3.eth.sendSignedTransaction(raw);
    console.log(`Transaction hash: ${txReceipt.transactionHash}`);
  } catch (e) {
    console.log(e);
  }
}

async function signal(lockdropContractAddress, signalingAddress, creationNonce, edgeAddress, remoteUrl=LOCALHOST_URL) {
  console.log(`Signaling from address ${signalingAddress} with nonce ${creationNonce} in lockdrop contract ${lockdropContractAddress}. Receiver ${edgeAddress}`);
  console.log("");
  const web3 = getWeb3(remoteUrl);
  const contract = new web3.eth.Contract(LOCKDROP_JSON.abi, lockdropContractAddress);
  try {
    // Default to HD-Wallet-Provider since EthereumJS-Tx breaks with Signal function
    const txReceipt = await contract.methods.signal(signalingAddress, creationNonce, edgeAddress).send({
      from: web3.currentProvider.addresses[0],
      gas: 150000,
    });
    console.log(`Transaction hash: ${txReceipt.transactionHash}`);
  } catch (e) {
    console.log(e);
  }
}

async function unlock(lockContractAddress, remoteUrl=LOCALHOST_URL, nonce=undefined) {
  console.log(`Unlocking lock contract: ${lockContractAddress}`);
  const web3 = getWeb3(remoteUrl);
  try {
    // Grab account's transaction nonce for tx params if nonce is not provided
    if (!nonce) {
      nonce = await web3.eth.getTransactionCount(web3.currentProvider.addresses[0]);
    }
    // Create generic send transaction to unlock from the lock contract
    const tx = new EthereumTx({
      nonce: nonce,
      from: web3.currentProvider.addresses[0],
      to: lockContractAddress,
      gas: 100000,
    });
    // Sign the tx and send it
    tx.sign(Buffer.from(ETH_PRIVATE_KEY, 'hex'));
    var raw = '0x' + tx.serialize().toString('hex');
    const txReceipt = await web3.eth.sendSignedTransaction(raw);
    console.log(`Transaction hash: ${txReceipt.transactionHash}`);
  } catch(e) {
    console.log(e);
  }
}

async function unlockAll(lockdropContractAddress, remoteUrl=LOCALHOST_URL) {
  const web3 = getWeb3(remoteUrl);
  console.log(`Fetching all locks for user ${web3.currentProvider.addresses[0]} for lockdrop contract ${lockdropContractAddress}\n`);
  const balanceBefore = web3.utils.fromWei((await web3.eth.getBalance(web3.currentProvider.addresses[0])), 'ether');
  console.log(`Balance before unlocking: ${balanceBefore}`);
  const locks = await getLocksForAddress(web3.currentProvider.addresses[0], lockdropContractAddress, remoteUrl);
  let txNonce = await web3.eth.getTransactionCount(web3.currentProvider.addresses[0]);
  let promises = locks.map(async (lock, inx) => {
    return await unlock(lock.lockContractAddr, remoteUrl, txNonce + inx);
  });

  await Promise.all(promises);
  const afterBalance = web3.utils.fromWei((await web3.eth.getBalance(web3.currentProvider.addresses[0])), 'ether');
  console.log(`Balance after unlocking: ${afterBalance}`);
}

async function getBalance(lockdropContractAddress, remoteUrl=LOCALHOST_URL) {
  console.log(`Fetching Lockdrop balance from lockdrop contract ${lockdropContractAddress}\n`);
  const web3 = getWeb3(remoteUrl);
  const contract = new web3.eth.Contract(LOCKDROP_JSON.abi, lockdropContractAddress);
  let { totalETHLocked, totalEffectiveETHLocked } = await ldHelpers.getTotalLockedBalance(contract);
  let { totalETHSignaled, totalEffectiveETHSignaled } = await ldHelpers.getTotalSignaledBalance(web3, contract);
  return { totalETHLocked, totalEffectiveETHLocked, totalETHSignaled, totalEffectiveETHSignaled };
};

async function getEnding(lockdropContractAddress, remoteUrl=LOCALHOST_URL) {
  console.log(`Calculating ending of lock period for lockdrop contract ${lockdropContractAddress}\n`);
  const web3 = getWeb3(remoteUrl);
  const contract = new web3.eth.Contract(LOCKDROP_JSON.abi, lockdropContractAddress);
  const ending = await contract.methods.LOCK_END_TIME().call();
  const now = await getCurrentTimestamp(remoteUrl);
  return ending - now;
}

async function getLocksForAddress(userAddress, lockdropContractAddress, remoteUrl=LOCALHOST_URL) {
  const web3 = getWeb3(remoteUrl);
  const contract = new web3.eth.Contract(LOCKDROP_JSON.abi, lockdropContractAddress);
  const lockEvents = await ldHelpers.getLocks(contract, userAddress);
  const now = await getCurrentTimestamp(remoteUrl);

  let promises = lockEvents.map(async event => {
    let lockStorage = await ldHelpers.getLockStorage(web3, event.returnValues.lockAddr);
    return {
      owner: event.returnValues.owner,
      eth: web3.utils.fromWei(event.returnValues.eth, 'ether'),
      lockContractAddr: event.returnValues.lockAddr,
      term: event.returnValues.term,
      edgewareAddressAsBase58: bs58.encode(new Buffer(event.returnValues.edgewareAddr.slice(2), 'hex')),
      unlockTime: `${(lockStorage.unlockTime - now) / 60} minutes`,
    };
  });

  return await Promise.all(promises);
}

/**
 * Ensure that the input is a formed correctly
 * @param {String} input
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function validateBase58Input(input) {
  for (inx in input) {
    if (BASE58_ALPHABET.indexOf(input[inx]) == -1) {
      return false;
    }
  }
  return true;
}

const LOCKDROP_JSON = JSON.parse(fs.readFileSync('./build/contracts/Lockdrop.json').toString());
const LOCKDROP_CONTRACT_ADDRESS = process.env.LOCKDROP_CONTRACT_ADDRESS;
const EDGEWARE_PUBLIC_ADDRESS = process.env.EDGEWARE_PUBLIC_ADDRESS;
const LOCALHOST_URL = 'http://localhost:8545';

let ETH_PRIVATE_KEY;
if (process.env.ETH_PRIVATE_KEY) {
  ETH_PRIVATE_KEY = (process.env.ETH_PRIVATE_KEY.indexOf('0x') === -1)
    ? process.env.ETH_PRIVATE_KEY
    : process.env.ETH_PRIVATE_KEY.slice(2);
}

// At least one should be populated
if (LOCKDROP_CONTRACT_ADDRESS) {
  program.lockdropContractAddress = LOCKDROP_CONTRACT_ADDRESS;
}

if (!program.lockdropContractAddress && !LOCKDROP_CONTRACT_ADDRESS) {
  throw new Error('Input a contract address for the Lockdrop contract');
}

// If passed in through .env
if (LOCKDROP_CONTRACT_ADDRESS) {
  program.lockdropContractAddress = LOCKDROP_CONTRACT_ADDRESS
}

// If no remote url provided, default to localhost
if (!program.remoteUrl) {
  program.remoteUrl = LOCALHOST_URL;
}

// For all functions that require signing, ensure private key is stored in .env file
if (program.lock || program.signal || program.unlock || program.unlockAll) {
  if (!ETH_PRIVATE_KEY) {
    throw new Error('Please add your private key hex to a .env file in the project directory');
  }
}

// For signaling and locking, ensure an edgeware public address is provided
if (program.signal || program.lock) {
  if (!program.edgeAddress) {
    if (EDGEWARE_PUBLIC_ADDRESS) {
      program.edgeAddress = EDGEWARE_PUBLIC_ADDRESS;
    } else {
      throw new Error('Please input an edgeware public address with --edgeAddress');
    }
  }

  // If edgeAddress is provided, ensure it is decoded to hex form if submitted as Base58 address
  if (validateBase58Input(program.edgeAddress)) {
    program.edgeAddress = `0x${bs58.decode(program.edgeAddress).toString('hex')}`
  }
}

if (program.allocation) {
  (async function() {
    const json = await getLockdropAllocation(program.lockdropContractAddress, program.remoteUrl);
    console.log(json);
    process.exit(0);
  })();
}

if (program.balance) {
  (async function() {
    let {
      totalETHLocked,
      totalETHSignaled,
      totalEffectiveETHLocked,
      totalEffectiveETHSignaled
    } = await getBalance(program.lockdropContractAddress, program.remoteUrl);
    console.log(`Total ETH locked: ${fromWei(totalETHLocked, 'ether')}\nTotal ETH signaled: ${fromWei(totalETHSignaled, 'ether')}`);
    console.log(`Total effective ETH locked: ${fromWei(totalEffectiveETHLocked, 'ether')}\nTotal effective ETH signaled: ${fromWei(totalEffectiveETHSignaled, 'ether')}`);
    process.exit(0);
  })();
};

if (program.ending) {
  (async function() {
    const timeDiff = await getEnding(program.lockdropContractAddress, program.remoteUrl);
    console.log(`Ending in ${(timeDiff) / 60} minutes`);
    process.exit(0);
  })();
}

if (program.lock) {
  // Ensure lock specific values are provided
  if (!program.lockLength || !program.lockValue) {
    throw new Error('Please input a length and value using --lockLength and --lockValue');
  }
  // Submit tx
  (async function() {
    await lock(program.lockdropContractAddress, program.lockLength, program.lockValue, program.edgeAddress, (!!program.isValidator), program.remoteUrl);
    process.exit(0);
  })();
}

if (program.signal) {
  // Check if signaling contract is actually a non-contract address, i.e. the address of the private key
  const providerAddress = getWeb3(program.remoteUrl).currentProvider.addresses[0];
  const isSame = (program.signal.toLowerCase() === providerAddress.toLowerCase());
  // If the provided address is a contract address (or not equal to the derived one), a nonce must be provided
  if (!isSame && !program.nonce) {
    throw new Error('Please input a transaction creation nonce for the signaling contract with --nonce\nIf signaling from a non-contract account use --nonce 0 or any value.');
  }
  // If the provided address is equal to the derived one, set a default nonce if none is provided
  if (isSame && !program.nonce) {
    program.nonce = 1;
  }
  // Submit tx
  (async function() {
    await signal(program.lockdropContractAddress, program.signal, program.nonce, program.edgeAddress, program.remoteUrl);
    process.exit(0);
  })();
}

if (program.unlock) {
  (async function() {
    await unlock(program.unlock, program.remoteUrl);
    process.exit(0);
  })();

}

if (program.unlockAll) {
  (async function() {
    await unlockAll(program.lockdropContractAddress, program.remoteUrl);
    process.exit(0);
  })();

}

if (program.locksForAddress) {
  (async function() {
    const locks = await getLocksForAddress(program.locksForAddress, program.lockdropContractAddress, program.remoteUrl);
    console.log(locks);
    process.exit(0);
  })();
}
