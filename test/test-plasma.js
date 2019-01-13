/* eslint-env mocha */
/* eslint-disable no-unused-expressions */

const compilePlasmaContract = require('../index.js')
const log = require('debug')('info:plasma-contract')
const ganache = require('ganache-cli')
const Web3 = require('web3')
const BN = Web3.utils.BN
const chai = require('chai')
const expect = chai.expect
const assert = chai.assert

const plasmaUtils = require('plasma-utils')
const PlasmaMerkleSumTree = plasmaUtils.PlasmaMerkleSumTree
const Transaction = plasmaUtils.serialization.models.Transaction

const MAX_END = new BN('170141183460469231731687303715884105727', 10) // this is not the right max end for 16 bytes, but we're gonna leave it for now as vyper has a weird bug only supporting uint128 vals
const IMAGINARY_PRECEDING = MAX_END.add(new BN(1))

// const encoder = require('plasma-utils').encoder

// SETUP WEB3 AND GANACHE
const web3 = new Web3()
const ganacheAccounts = []
for (let i = 0; i < 5; i++) {
  const privateKey = Web3.utils.sha3(i.toString())
  ganacheAccounts.push({
    balance: '0x99999999991',
    secretKey: privateKey
  })
  web3.eth.accounts.wallet.add(privateKey)
}
// For all provider options, see: https://github.com/trufflesuite/ganache-cli#library
const providerOptions = { 'accounts': ganacheAccounts, 'locked': false, 'logger': console }
web3.setProvider(ganache.provider(providerOptions))

async function mineBlock () {
  return new Promise((resolve, reject) => {
    web3.currentProvider.sendAsync({
      jsonrpc: '2.0',
      method: 'evm_mine',
      id: new Date().getTime()
    }, function (err, result) {
      if (err) {
        reject(err)
      }
      resolve(result)
    })
  })
}

async function mineNBlocks (n) {
  for (let i = 0; i < n; i++) {
    await mineBlock()
  }
  console.log('mined ' + n + ' empty blocks')
}

async function getCurrentChainSnapshot () {
  return new Promise((resolve, reject) => {
    web3.currentProvider.sendAsync({
      jsonrpc: '2.0',
      method: 'evm_snapshot',
      id: new Date().getTime()
    }, function (err, result) {
      if (err) {
        reject(err)
      }
      resolve(result)
    })
  })
}

async function revertToChainSnapshot (snapshot) { // eslint-disable-line no-unused-vars
  return new Promise((resolve, reject) => {
    web3.currentProvider.sendAsync({
      jsonrpc: '2.0',
      method: 'evm_revert',
      id: new Date().getTime(),
      params: [snapshot.result],
      external: true
    }, function (err, result) {
      if (err) {
        console.log(err)
        reject(err)
      }
      console.log('result: ', result)
      resolve(result)
    })
  })
}

describe('Plasma', () => {
  let bytecode, abi, plasmaCt, plasma, txs, tree
  let freshContractSnapshot // eslint-disable-line no-unused-vars

  before(async () => {
    [bytecode, abi] = await compilePlasmaContract()
    const addr = web3.eth.accounts.wallet[0].address

    plasmaCt = new web3.eth.Contract(JSON.parse(abi), addr, { from: addr, gas: 3500000, gasPrice: '300000' })
    // const balance = await web3.eth.getBalance(accounts[0].address)
    const bn = await web3.eth.getBlockNumber()
    await mineBlock()
    const bn2 = await web3.eth.getBlockNumber()
    log(bn)
    log(bn2)
    // Now try to deploy
    plasma = await plasmaCt.deploy({ data: bytecode }).send() /* {
     from: addr,
     gas: 2500000,
     gasPrice: '300000'
    })
    */
    const block = await web3.eth.getBlock('latest')
    const deploymentTransaction = await web3.eth.getTransaction(block.transactions[0]) // eslint-disable-line no-unused-vars
    freshContractSnapshot = await getCurrentChainSnapshot()

    txs = getSequentialTxs(32)
    tree = new PlasmaMerkleSumTree(txs)
  })

  it('Should compile the vyper contract without errors', async () => {
    log('Bytecode: ', bytecode.slice(0, 300), '...\n ABI: ', abi.slice(0, 300), '...')
    expect(abi).to.exist
    expect(bytecode).to.exist
    expect(plasma).to.exist
    expect(web3).to.exist
    expect(ganache).to.exist
  })
  const dummyBlockHash = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  it('should allow a block to be published by the operator', async () => {
    await mineNBlocks(10) // blocktime is 10
    await plasma.methods.submitBlock(dummyBlockHash).send({ value: 0, from: web3.eth.accounts.wallet[0].address, gas: 4000000 }, async function (error, result) { // get callback from function which is your transaction key
      if (!error) {
        // const receipt = await web3.eth.getTransactionReceipt(result)
      } else {
        assert.equal(true, false) // theres a better way but need to fail tests when things throw
        console.log(error)
      }
    }).catch((error) => { console.log('send callback failed: ', error) })
  })
  let bigDepositSnapshot // eslint-disable-line no-unused-vars
  it('should allow a first deposit and add it to the deposits correctly', async () => {
    let depositEnd, depositNextStart
    const depositSize = 50
    await plasma.methods.deposit(0).send({ value: depositSize, from: web3.eth.accounts.wallet[1].address, gas: 4000000 }, async function (error, result) { // get callback from function which is your transaction key
      if (error) {
        assert.equal(true, false) // there'ss a better way but need to fail tests when things throw
        console.log(error)
      }
    }).catch((error) => { console.log('send callback failed: ', error) })
    depositEnd = await plasma.methods.depositedRanges__end(0).call()
    depositNextStart = await plasma.methods.depositedRanges__nextDepositStart(0).call()
    assert.deepEqual(new BN(depositEnd), new BN(depositSize))
    assert.deepEqual(new BN(depositNextStart), MAX_END)
    bigDepositSnapshot = getCurrentChainSnapshot()
  })
  it('should allow left, right, and un-aligned exits if unchallenged', async () => {
    await plasma.methods.beginExit(0, 0, 10, 0).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })
    await plasma.methods.beginExit(0, 20, 30, 0).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })
    await plasma.methods.beginExit(0, 40, 50, 0).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })

    await mineNBlocks(20)

    await plasma.methods.finalizeExit(0, '0x' + IMAGINARY_PRECEDING.toString(16)).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })
    await plasma.methods.finalizeExit(1, 0).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })
    await plasma.methods.finalizeExit(2, 10).send({ value: 0, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })

    const imaginaryNext = await plasma.methods.depositedRanges__nextDepositStart('0x' + IMAGINARY_PRECEDING.toString(16)).call()
    const firstDepositEnd = await plasma.methods.depositedRanges__end(0).call()
    const firstDepositNextStart = await plasma.methods.depositedRanges__nextDepositStart(0).call()
    const middleDepositEnd = await plasma.methods.depositedRanges__end(10).call()
    const middleDepositNextStart = await plasma.methods.depositedRanges__nextDepositStart(10).call()
    const lastDepositEnd = await plasma.methods.depositedRanges__end(30).call()
    const lastDepositNextStart = await plasma.methods.depositedRanges__nextDepositStart(30).call()

    assert.equal(imaginaryNext, '0')
    assert.equal(firstDepositEnd, '0')
    assert.equal(firstDepositNextStart, '10')
    assert.equal(middleDepositEnd, '20')
    assert.equal(middleDepositNextStart, '30')
    assert.equal(lastDepositEnd, '40')
    assert.equal(lastDepositNextStart, MAX_END.toString())
  })
  it('should allow re-deposits into exited ranges', async () => {
    await plasma.methods.deposit(0).send({ value: 5, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })
    await plasma.methods.deposit(10).send({ value: 10, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })
    await plasma.methods.deposit(10).send({ value: 5, from: web3.eth.accounts.wallet[1].address, gas: 4000000 })

    const firstRangeEnd = await plasma.methods.depositedRanges__end(0).call()
    const firstRangeNext = await plasma.methods.depositedRanges__nextDepositStart(0).call()
    const middleRangeEnd = await plasma.methods.depositedRanges__end(10).call()
    const middleRangeNext = await plasma.methods.depositedRanges__nextDepositStart(10).call()
    assert.equal(firstRangeEnd, '5')
    assert.equal(firstRangeNext, '10')
    assert.equal(middleRangeEnd, '45')
    assert.equal(middleRangeNext, '170141183460469231731687303715884105727')
  })
  it('should getLeafHash of an encoded transaction', async () => {
    const index = Math.floor(Math.random() * 32)
    const tx = txs[index]
    const possibleHash = await plasma.methods.getLeafHash('0x' + tx.encoded).call()
    assert.equal(possibleHash, '0x' + tree.levels[0][index].hash)
  })
  it('should decodeBlockNumber from a tx', async () => {
    // todo make this not 0 to improve testing coverage lol
    const index = Math.floor(Math.random() * 32)
    const tx = txs[index]
    const possibleBN = await plasma.methods.decodeBlockNumber('0x' + tx.encoded).call()
    assert.equal(possibleBN, new BN(tx.args.transfer.block).toString())
  })
  it('should decode transferBounds from a tx', async () => {
    const index = Math.floor(Math.random() * 32)
    const tx = txs[index]
    const possibleBounds = await plasma.methods.decodeIthTransferBounds(0, '0x' + tx.encoded).call()
    assert.equal(possibleBounds[0], new BN(tx.args.transfer.start).toString())
    assert.equal(possibleBounds[1], new BN(tx.args.transfer.end).toString())
  })
  it('should decode transferFrom from a tx', async () => {
    // todo make this not 0 address to improve testing coverage
    const index = Math.floor(Math.random() * 32)
    const tx = txs[index]
    const possibleFrom = await plasma.methods.decodeIthTransferFrom(0, '0x' + tx.encoded).call()
    assert.equal(possibleFrom, tx.args.transfer.sender)
  })
  it('should decode transferTo from a tx', async () => {
    // todo make this not 0 address to improve testing coverage
    const index = Math.floor(Math.random() * 32)
    const tx = txs[index]
    const possibleFrom = await plasma.methods.decodeIthTransferTo(0, '0x' + tx.encoded).call()
    assert.equal(possibleFrom, tx.args.transfer.recipient)
  })
  it('should properly check individual branch proofs and get implicit bounds', async () => {
    await plasma.methods.submitBlock('0x' + tree.root().hash).send({ value: 0, from: web3.eth.accounts.wallet[0].address, gas: 4000000 })
    const index = Math.floor(Math.random() * 32)
    let proof = tree.getInclusionProof(index)
    const parsedSum = proof[0].sum
    proof.shift()
    let proofString = '0x'
    proof.forEach((element) => { proofString = proofString + element.hash + element.sum.toString(16, 32) })
    const possibleImplicitBounds = await plasma.methods.checkBranchAndGetBounds(
      web3.utils.soliditySha3('0x' + txs[index].encoded),
      '0x' + parsedSum.toString(16, 32),
      index,
      proofString,
      1
    ).call()
    assert.equal(possibleImplicitBounds[0], new BN(txs[index].args.transfer.start))
    assert(new BN(possibleImplicitBounds[1]).gte(new BN(txs[index].args.transfer.end)))
  })
  it('should properly check full tx proofs and get transfer & blocknumber', async () => {
    const index = Math.floor(Math.random() * 32)
    let proof = tree.getInclusionProof(index)
    const parsedSum = proof[0].sum
    proof.shift()
    let proofString = '0x'
    proof.forEach((element) => { proofString = proofString + element.hash + element.sum.toString(16, 32) })
    debugger
    const returned = await plasma.methods.checkTXValidityAndGetTransfer(
      0,
      '0x' + txs[index].encoded,
      '0x' + parsedSum.toString(16, 32),
      '0x' + new BN(index).toString(16, 2),
      proofString
    ).call()
    debugger
  })
})

/**
 * Returns a list of `n` sequential transactions.
 * @param {*} n Number of sequential transactions to return.
 * @return {*} A list of sequential transactions.
 */
const getSequentialTxs = (n) => {
  let txs = []
  debugger
  for (let i = 0; i < n; i++) {
    txs[i] = new Transaction({
      transfer: {
        sender: '0x0000000000000000000000000000000000000000',
        recipient: web3.eth.accounts.wallet[1].address,
        token: 0,
        start: i * 20,
        end: (i + 0.5) * 20,
        block: 1
      },
      signature: {
        v: 0,
        r: 0,
        s: 0
      }
    })
  }

  return txs
}
