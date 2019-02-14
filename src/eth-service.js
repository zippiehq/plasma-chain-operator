const colors = require('colors') // eslint-disable-line no-unused-vars
const plasmaChainCompiled = require('plasma-contracts').plasmaChainCompiled
const plasmaRegistryCompiled = require('plasma-contracts').plasmaRegistryCompiled
const serializerCompiled = require('plasma-contracts').serializerCompiled
const Web3 = require('web3')
const ganache = require('ganache-cli')
const log = require('debug')('info:eth')
const EventWatcher = require('./event-watcher.js')
const { loadEthDB, writeEthDB } = require('./eth-db.js')

const DEPLOY_REGISTRY = 'DEPLOY'

// ES short for EthService
// `web3` & `plasmaChain` start as uninitialized because the startup script must be run before we can interact meaningfully with our node
const UNINITIALIZED = 'UNINITIALIZED'
const es = {
  web3: UNINITIALIZED,
  ganacheServer: UNINITIALIZED,
  plasmaChain: UNINITIALIZED,
  operatorAddress: UNINITIALIZED,
  eventWatchers: UNINITIALIZED,
  ethDB: {}
}

// Startup function called to initialize everything
async function startup (config) {
  es.web3 = new Web3()
  // Initalize our wallet
  initializeWallet(es.web3, config.privateKey)
  // Load the ethDB database
  es.ethDB = loadEthDB(config)
  // Check if we are in test mode
  if (process.env.NODE_ENV === 'test') {
    await initializeTestingEnv(config)
  } else {
    await initializeProdEnv(config)
  }
  // Create our plasma chain es.web3 object, this will point to an existing Ethereum smart contract
  es.plasmaChain = new es.web3.eth.Contract(plasmaChainCompiled.abi, es.ethDB.plasmaChainAddress, {from: es.operatorAddress})
  // Load our event handlers
  es.eventWatchers = _getEventWatchers(config)
  console.log('Plasma Registry address:', es.ethDB.plasmaRegistryAddress.yellow)
  console.log('Plasma Chain address:', es.ethDB.plasmaChainAddress.yellow)
}

function _getEventWatchers (config) {
  const eventWatchers = {}
  for (const ethEvent of Object.keys(es.plasmaChain.events)) {
    if (ethEvent.slice(0, 2) === '0x' || ethEvent.includes('(')) {
      // Filter out all of the events that are not of the form `DepositEvent(address,uint256)`
      continue
    }
    log('Creating event watcher for event:', ethEvent)
    eventWatchers[ethEvent] = new EventWatcher(es.web3, es.plasmaChain, ethEvent, config.finalityDepth, config.ethPollInterval)
  }
  return eventWatchers
}

function initializeWallet (web3, privateKey) {
  if (privateKey !== undefined) {
    es.web3.eth.accounts.wallet.add(privateKey)
  } else if (process.env.NODE_ENV === 'test') {
    _addTestWalletsToWeb3(es.web3) // If we are in test mode & there is no private key, add some fake private keys
  } else {
    throw new Error('No private key specified!')
  }
  es.operatorAddress = es.web3.eth.accounts.wallet[0].address
  console.log('Operator address:', es.operatorAddress.yellow)
}

async function initializeTestingEnv (config) {
  // First get our es.web3 object which we will use. This comes with some wallets that have $ in them
  await _setupGanache(es.web3, config)
  // Deploy a new Plasma Registry
  await deployNewPlasmaRegistry(config)
  // Deploy our new Plasma Chain and save it in a file
  es.ethDB.plasmaChainAddress = await deployNewPlasmaChain(es.web3, config)
  console.log('Testing mode enabled so deployed a new Plasma Registry & Plasma Chain')
  writeEthDB(config, es.ethDB)
}

async function deployNewPlasmaRegistry (config) {
  // Deploy a new PlasmaRegistry. This requires first deploying a dummy Plasma Chain
  // We have the compiled contracts, let's create objects for them...
  const plasmaSerializerCt = new es.web3.eth.Contract(serializerCompiled.abi, es.operatorAddress, {from: es.operatorAddress, gas: 7000000, gasPrice: '5000000000'})
  const plasmaChainCt = new es.web3.eth.Contract(plasmaChainCompiled.abi, es.operatorAddress, {from: es.operatorAddress, gas: 7000000, gasPrice: '5000000000'})
  const plasmaRegistryCt = new es.web3.eth.Contract(plasmaRegistryCompiled.abi, es.operatorAddress, {from: es.operatorAddress, gas: 7000000, gasPrice: '5000000000'})
  const serializer = await plasmaSerializerCt.deploy({ data: serializerCompiled.bytecode }).send()
  // To set up the Plasma Network, we need to first deploy a Plasma Chain contract
  const plasmaChain = await plasmaChainCt.deploy({ data: plasmaChainCompiled.bytecode }).send()
  // Finally deploy the Plasma Registry and save the address in our ethDB
  const plasmaRegistry = await plasmaRegistryCt.deploy({ data: plasmaRegistryCompiled.bytecode }).send()
  es.ethDB.plasmaRegistryAddress = plasmaRegistry.options.address
  writeEthDB(config, es.ethDB)
  log('Deployed a Plasma Registry at', es.ethDB.plasmaRegistryAddress)
  // Initialize the registry
  await plasmaRegistry.methods.initializeRegistry(plasmaChain.options.address, serializer.options.address).send()
}

async function initializeProdEnv (config) {
  if (config.web3WebsocketProvider) {
    es.web3.setProvider(new Web3.providers.WebsocketProvider(config.web3WebsocketProvider))
  } else if (config.web3HttpProvider === undefined) {
    throw new Error('Web3 provider undefined!')
  } else {
    es.web3.setProvider(new Web3.providers.HttpProvider(config.web3HttpProvider))
  }
  // Check if we need to deploy a new Plasma registry.
  if (es.ethDB.plasmaRegistryAddress === DEPLOY_REGISTRY) {
    console.log('Deploying new registry...This could take some time.'.green)
    if (config.web3HttpProvider !== undefined && config.web3HttpProvider.includes('rinkeby')) {
      console.log('View transaction progress on Etherscan:', 'https://rinkeby.etherscan.io/address/'.blue + es.operatorAddress.blue)
    }
    await deployNewPlasmaRegistry(config)
    log('New registry at address:', es.ethDB.plasmaRegistryAddress)
    es.ethDB.plasmaChainAddress = undefined
  }
  // Check if we need to deploy a new Plasma Chain
  if (es.ethDB.plasmaChainAddress === undefined) {
    // Check that the plasma registry was deployed
    const plasmaRegistryCode = await es.web3.eth.getCode(es.ethDB.plasmaRegistryAddress)
    if (plasmaRegistryCode === '0x') {
      throw new Error('No plasma registry found at address: ' + es.ethDB.plasmaRegistryAddress)
    }
    // Deploy a new Plasma Chain and save it in a file
    es.ethDB.plasmaChainAddress = await deployNewPlasmaChain(es.web3, config)
    console.log('No Plasma Chain contract detected! Deploying an new one...'.green)
    log('Deployed Plasma Chain to address:', es.ethDB.plasmaChainAddress)
    writeEthDB(config, es.ethDB)
  } else {
    console.log('Plasma Chain contract already deployed. Skipping deployment...'.green)
  }
}

async function deployNewPlasmaChain (web3, config) {
  // We have the compiled contracts, let's create objects for them...
  const plasmaRegistry = new web3.eth.Contract(plasmaRegistryCompiled.abi, es.ethDB.plasmaRegistryAddress)
  let createPChainReciept
  try {
    console.log('Deploying new Plasma Chain... this could take a while')
    if (config.web3HttpProvider !== undefined && config.web3HttpProvider.includes('rinkeby')) {
      console.log('View transaction progress on Etherscan:', 'https://rinkeby.etherscan.io/address/'.blue + es.operatorAddress.blue)
    }
    createPChainReciept = await plasmaRegistry.methods.createPlasmaChain(es.operatorAddress, Buffer.from(config.plasmaChainName), Buffer.from(config.operatorIpAddress)).send({ from: es.operatorAddress, gas: 800000, gasPrice: '5000000000' })
  } catch (err) {
    if (err.toString().includes('gas * price')) {
      console.log('ERROR DEPLOYING CHAIN'.red, '\nYou do not have enough ETH to pay for the deployment.\nGet some using a faucet (https://faucet.rinkeby.io/)')
      console.log('\n\n', err)
      process.exit(1)
    } else if (err.toString().includes('gas * price')) {
      console.log('ERROR DEPLOYING CHAIN'.red, '\nYour Plasma Chain name may be taken! Try another--they\'re filling up quick!')
      console.log('\n\n', err)
      process.exit(1)
    }
    throw err
  }
  const newPlasmaChainAddress = createPChainReciept.events.NewPlasmaChain.returnValues['0']
  log('Deployed a Plasma Chain at', newPlasmaChainAddress)
  return newPlasmaChainAddress
}

function _addTestWalletsToWeb3 (web3) {
  log('Filling wallet with test private keys')
  for (let i = 0; i < 100; i++) {
    web3.eth.accounts.wallet.add(web3.utils.sha3(i.toString()))
  }
}

async function _startGanacheServer (server, port) {
  return new Promise((resolve) => {
    server.listen(port, resolve)
  })
}

async function _setupGanache (web3, config) {
  const ganacheAccounts = []
  for (let i = 0; i < web3.eth.accounts.wallet.length; i++) {
    ganacheAccounts.push({
      balance: '0x100000000000000000000',
      secretKey: web3.eth.accounts.wallet[i].privateKey
    })
  }
  // For all provider options, see: https://github.com/trufflesuite/ganache-cli#library
  const providerOptions = {'accounts': ganacheAccounts, 'gasLimit': '0x7A1200', 'locked': false, 'logger': { log }}
  // If we are given an HttpProvider, use a ganache server instead of as a local library
  if (config.testHttpProviderPort !== undefined) {
    es.ganacheServer = ganache.server(providerOptions)
    await _startGanacheServer(es.ganacheServer, config.testHttpProviderPort)
    web3.setProvider(new Web3.providers.HttpProvider('http://localhost:' + config.testHttpProviderPort))
  } else {
    // No port given, so run as local library
    web3.setProvider(ganache.provider(providerOptions))
    web3.currentProvider.setMaxListeners(300) // TODO: Remove this as it is squashing errors. See https://github.com/ethereum/web3.js/issues/1648
  }
}

async function submitRootHash (rootHash) {
  var foo = Math.random()
  log('submitting root hash ' + rootHash + ' ' + foo)
  var reciept = await es.plasmaChain.methods.submitBlock('0x' + rootHash).send({gas: 400000, gasPrice: '1000000000'})
  log('Ethereum reciept for block number:', reciept.events.SubmitBlockEvent.returnValues['0'], 'wish root hash:', reciept.events.SubmitBlockEvent.returnValues['1'])
  log('done submit root hash ' + rootHash + ' ' + foo)
}

// Set functions which we will export as well
es.startup = startup
es.submitRootHash = submitRootHash

module.exports = es
